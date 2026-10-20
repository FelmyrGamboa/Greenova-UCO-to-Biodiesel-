/*
 * Greenova ESP32-WROOM-32 actuator bridge — based on the operator-supplied pin list.
 *
 * USB serial protocol: one JSON object per line, 115200 baud. The Pi is responsible for all
 * process interlocks. This sketch only carries out explicitly named outputs, reports temperature,
 * and turns outputs off if no heartbeat/command arrives for 2 seconds.
 *
 * IMPORTANT: The supplied wiring names a single generic `valve` relay (GPIO27) and six other
 * relay outputs. Greenova requires three independently controlled outlet valves and two named
 * chemical dosing pumps. Their physical relay roles were not clear from the supplied sketch, so
 * the logical Greenova valve/pump aliases below deliberately remain unmapped (-1). Do not drive
 * real process outputs until these assignments are confirmed and tested.
 *
 * ESP32 GPIO table (BCM numbering does not apply to ESP32):
 * 8-channel relay module:
 *   IN8 dispenser1 GPIO22; IN7 dispenser2 GPIO21; IN6 reactorpump GPIO19;
 *   IN5 pumpin GPIO18; IN4 oil GPIO25; IN3 pumpout GPIO26;
 *   IN2 generic valve GPIO27; IN1 electrode GPIO13.
 * Separate 30 A heater relay input GPIO15. DS18B20 data GPIO5 (4.7 kOhm pull-up to 3.3 V).
 * L298N Mixer 1: IN3 GPIO23, IN4 GPIO17, ENB GPIO16.
 * L298N Mixer 2: IN1 GPIO33, IN2 GPIO14, ENA GPIO32.
 * The BTS7960 centrifuge is driven directly by the Raspberry Pi, not this ESP32, in the supplied
 * Pi sketch. Pi pins: L_EN=23, R_EN=24, LPWM=25, RPWM=21; HX711 DT=17, SCK=27.
 *
 * Arduino libraries: ArduinoJson, OneWire, DallasTemperature.
 */
#include <Arduino.h>
#include <ArduinoJson.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// ---- Relay module: physical names directly from the supplied sketch ----
static const int PIN_DISPENSER1 = 22; // Relay IN8; Greenova pump role needs confirmation
static const int PIN_DISPENSER2 = 21; // Relay IN7; Greenova pump role needs confirmation
static const int PIN_REACTORPUMP = 19; // Relay IN6
static const int PIN_PUMPIN = 18;      // Relay IN5
static const int PIN_OIL = 25;         // Relay IN4
static const int PIN_PUMPOUT = 26;     // Relay IN3
static const int PIN_GENERIC_VALVE = 27; // Relay IN2; which Greenova valve is TODO
static const int PIN_ELECTRODE = 13;   // Relay IN1
static const int PIN_HEATER = 15;      // Separate 30 A heater relay

// ---- Greenova logical mappings not determinable from the supplied labels ----
static const int PIN_PUMP_A = -1;              // TODO: confirm which relay is catalyst pump A
static const int PIN_PUMP_B = -1;              // TODO: confirm which relay is acid pump B
static const int PIN_REACTOR_OUTLET = -1;      // TODO: assign an independent outlet relay/driver
static const int PIN_CENTRIFUGE_OUTLET = -1;   // TODO: assign an independent outlet relay/driver
static const int PIN_PURIFICATION_OUTLET = -1; // TODO: assign an independent outlet relay/driver

// ---- L298N mixers ----
static const int PIN_MIXER1_IN1 = 23; // supplied sketch IN3
static const int PIN_MIXER1_IN2 = 17; // supplied sketch IN4
static const int PIN_MIXER1_EN = 16;  // supplied sketch ENB
static const int PIN_MIXER2_IN1 = 33; // supplied sketch IN1
static const int PIN_MIXER2_IN2 = 14; // supplied sketch IN2
static const int PIN_MIXER2_EN = 32;  // supplied sketch ENA

static const int PIN_TEMP = 5;
static const bool RELAY_ACTIVE_LOW = false; // supplied sketch setting: confirm by bench test
static const bool HEATER_ACTIVE_LOW = false;
static const uint32_t LINK_TIMEOUT_MS = 2000;
static uint32_t lastMessageMs = 0;
static uint32_t lastTempMs = 0;
static bool mixer1On = false;
static bool mixer2On = false;
static float mixer1Duty = 0.0f;
static float mixer2Duty = 0.0f;
static float temperatureC = NAN;
static String lineBuffer;
OneWire oneWire(PIN_TEMP);
DallasTemperature tempSensor(&oneWire);

static const int RELAY_PINS[] = {PIN_DISPENSER1, PIN_DISPENSER2, PIN_REACTORPUMP, PIN_PUMPIN,
                                 PIN_OIL, PIN_PUMPOUT, PIN_GENERIC_VALVE, PIN_ELECTRODE, PIN_HEATER};

void relayWrite(int pin, bool on, bool activeLow = RELAY_ACTIVE_LOW) {
  if (pin < 0) return;
  digitalWrite(pin, on ? (activeLow ? LOW : HIGH) : (activeLow ? HIGH : LOW));
}

void mixerApply(int in1, int in2, int en, bool on, float duty) {
  if (on && duty > 0.0f) {
    digitalWrite(in1, HIGH);
    digitalWrite(in2, LOW);
    analogWrite(en, (int)roundf(constrain(duty, 0.0f, 1.0f) * 255.0f));
  } else {
    analogWrite(en, 0);
    digitalWrite(in1, LOW);
    digitalWrite(in2, LOW);
  }
}

void allOff() {
  for (int pin : RELAY_PINS) relayWrite(pin, false, pin == PIN_HEATER ? HEATER_ACTIVE_LOW : RELAY_ACTIVE_LOW);
  mixer1On = mixer2On = false;
  mixer1Duty = mixer2Duty = 0.0f;
  mixerApply(PIN_MIXER1_IN1, PIN_MIXER1_IN2, PIN_MIXER1_EN, false, 0.0f);
  mixerApply(PIN_MIXER2_IN1, PIN_MIXER2_IN2, PIN_MIXER2_EN, false, 0.0f);
}

int relayPinForName(const char *name, bool &heater) {
  heater = false;
  if (!strcmp(name, "dispenser1")) return PIN_DISPENSER1;
  if (!strcmp(name, "dispenser2")) return PIN_DISPENSER2;
  if (!strcmp(name, "reactorpump")) return PIN_REACTORPUMP;
  if (!strcmp(name, "pumpin")) return PIN_PUMPIN;
  if (!strcmp(name, "oil")) return PIN_OIL;
  if (!strcmp(name, "pumpout")) return PIN_PUMPOUT;
  if (!strcmp(name, "valve")) return PIN_GENERIC_VALVE;
  if (!strcmp(name, "electrode")) return PIN_ELECTRODE;
  if (!strcmp(name, "heater")) { heater = true; return PIN_HEATER; }
  if (!strcmp(name, "pump_a")) return PIN_PUMP_A;
  if (!strcmp(name, "pump_b")) return PIN_PUMP_B;
  if (!strcmp(name, "reactor_outlet")) return PIN_REACTOR_OUTLET;
  if (!strcmp(name, "centrifuge_outlet")) return PIN_CENTRIFUGE_OUTLET;
  if (!strcmp(name, "purification_outlet")) return PIN_PURIFICATION_OUTLET;
  if (!strcmp(name, "electrode_power")) return PIN_ELECTRODE;
  return -1;
}

void reportResult(JsonDocument &out) {
  if (!isnan(temperatureC)) out["temperatureC"] = temperatureC;
  else out["temperatureC"] = nullptr;
  serializeJson(out, Serial);
  Serial.println();
}

void sendError(const char *name, const char *error) {
  StaticJsonDocument<192> out;
  out["ok"] = false;
  out["name"] = name;
  out["error"] = error;
  reportResult(out);
}

void hwtest() {
  // This is a deliberately brief output pulse test. Disconnect the heater power and chemical
  // feed lines first. Only mapped generic relay outputs are pulsed; TODO Greenova aliases are not.
  const struct { const char *name; int pin; bool heater; } checks[] = {
    {"dispenser1", PIN_DISPENSER1, false}, {"dispenser2", PIN_DISPENSER2, false},
    {"reactorpump", PIN_REACTORPUMP, false}, {"pumpin", PIN_PUMPIN, false},
    {"oil", PIN_OIL, false}, {"pumpout", PIN_PUMPOUT, false},
    {"valve", PIN_GENERIC_VALVE, false}, {"electrode", PIN_ELECTRODE, false},
    {"heater", PIN_HEATER, true}
  };
  for (const auto &item : checks) {
    StaticJsonDocument<128> out;
    out["hwtest"] = item.name;
    out["mapped"] = item.pin >= 0;
    reportResult(out);
    if (item.pin >= 0) {
      relayWrite(item.pin, true, item.heater ? HEATER_ACTIVE_LOW : RELAY_ACTIVE_LOW);
      delay(150);
      relayWrite(item.pin, false, item.heater ? HEATER_ACTIVE_LOW : RELAY_ACTIVE_LOW);
    }
  }
  StaticJsonDocument<128> done;
  done["ok"] = true;
  done["hwtest"] = "complete";
  reportResult(done);
}

void handleLine(const String &line) {
  StaticJsonDocument<384> in;
  DeserializationError err = deserializeJson(in, line);
  if (err) { sendError("command", "invalid JSON"); return; }
  const char *cmd = in["cmd"] | "";
  if (!strcmp(cmd, "heartbeat")) {
    StaticJsonDocument<160> out;
    out["ok"] = true; out["heartbeat"] = true;
    out["mixer1Duty"] = mixer1Duty; out["mixer2Duty"] = mixer2Duty;
    reportResult(out);
    return;
  }
  if (!strcmp(cmd, "allOff")) {
    allOff();
    StaticJsonDocument<128> out;
    out["ok"] = true; out["name"] = "allOff"; out["allOff"] = true;
    reportResult(out);
    return;
  }
  if (!strcmp(cmd, "hwtest")) { hwtest(); return; }
  if (!strcmp(cmd, "relay")) {
    const char *name = in["name"] | "";
    bool on = in["on"] | false;
    bool heater = false;
    int pin = relayPinForName(name, heater);
    if (pin < 0) { sendError(name, "output mapping is not assigned; check the wiring map before use"); return; }
    relayWrite(pin, on, heater ? HEATER_ACTIVE_LOW : RELAY_ACTIVE_LOW);
    StaticJsonDocument<160> out;
    out["ok"] = true; out["name"] = name; out["on"] = on;
    reportResult(out);
    return;
  }
  if (!strcmp(cmd, "pwm")) {
    const char *name = in["name"] | "";
    float duty = constrain((float)(in["duty"] | 0.0f), 0.0f, 1.0f);
    if (!strcmp(name, "mixer1")) {
      mixer1Duty = duty; mixer1On = duty > 0.0f;
      mixerApply(PIN_MIXER1_IN1, PIN_MIXER1_IN2, PIN_MIXER1_EN, mixer1On, mixer1Duty);
    } else if (!strcmp(name, "mixer2")) {
      mixer2Duty = duty; mixer2On = duty > 0.0f;
      mixerApply(PIN_MIXER2_IN1, PIN_MIXER2_IN2, PIN_MIXER2_EN, mixer2On, mixer2Duty);
    } else {
      sendError(name, "only mixer1 and mixer2 are assigned on the ESP32; the centrifuge is wired to the Pi");
      return;
    }
    StaticJsonDocument<160> out;
    out["ok"] = true; out["name"] = name; out["duty"] = duty;
    reportResult(out);
    return;
  }
  sendError(cmd, "unknown command");
}

void updateTemperature() {
  if (millis() - lastTempMs < 1000) return;
  lastTempMs = millis();
  const float value = tempSensor.getTempCByIndex(0);
  temperatureC = (value == DEVICE_DISCONNECTED_C || value == 85.0f || value == -127.0f) ? NAN : value;
  tempSensor.requestTemperatures();
}

void setup() {
  Serial.begin(115200);
  // Set output pins to OFF before starting any sensor or control activity.
  for (int pin : RELAY_PINS) {
    if (pin < 0) continue;
    pinMode(pin, OUTPUT);
    relayWrite(pin, false, pin == PIN_HEATER ? HEATER_ACTIVE_LOW : RELAY_ACTIVE_LOW);
  }
  for (int pin : {PIN_MIXER1_IN1, PIN_MIXER1_IN2, PIN_MIXER1_EN,
                  PIN_MIXER2_IN1, PIN_MIXER2_IN2, PIN_MIXER2_EN}) pinMode(pin, OUTPUT);
  allOff();
  tempSensor.begin();
  tempSensor.setWaitForConversion(false);
  tempSensor.requestTemperatures();
  lastMessageMs = millis();
}

void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      lineBuffer.trim();
      if (lineBuffer.length()) {
        lastMessageMs = millis();
        handleLine(lineBuffer);
      }
      lineBuffer = "";
    } else if (lineBuffer.length() < 512) {
      lineBuffer += c;
    } else {
      lineBuffer = "";
    }
  }
  updateTemperature();
  if (millis() - lastMessageMs > LINK_TIMEOUT_MS) allOff();
  delay(2);
}
