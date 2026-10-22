/*
  ESP32 Process Controller
  - 8-channel relay board + separate heater relay
  - L298N driving 2 mixers (on/off + PWM speed)
  - DS18B20 temperature sensor
  - Serial commands + web interface (ON / OFF / timed ON per device)

  Libraries (Library Manager): OneWire, DallasTemperature
  Board: ESP32 Dev Module (ESP32 Arduino core 2.x or 3.x)

  NOTE: You listed BOTH the temp sensor and the heater relay on GPIO 5.
        One pin can't do both, so the heater stays on GPIO 5 and the
        temp sensor is moved to GPIO 4 (free pin). Change TEMP_PIN if needed.
*/

#include <WiFi.h>
#include <WebServer.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// ================== WIFI ==================
const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

// ================== L298N ==================
#define ENA 32   // Mixer 2 speed (PWM)
#define IN1 33   // Mixer 2
#define IN2 14   // Mixer 2
#define IN3 23   // Mixer 1
#define IN4 17   // Mixer 1  (TX2)
#define ENB 16   // Mixer 1 speed (PWM) (RX2)

// ================== MOTOR SPEED (RPM) ==================
// No speed sensor, so RPM is converted to PWM (open loop):
//   MAX_RPM  -> PWM 255 (full speed)
//   1 RPM    -> MIN_PWM (lowest PWM where your motor still turns)
// Raise MIN_PWM if the motor hums but doesn't spin at low RPM.
// 90: the L298N mixers didn't turn at low speeds with 0 (200 RPM was PWM 33). With 90, 200 RPM
// is PWM 111 and the RPM you set is exactly the RPM this sketch reports (STATUS "rpm").
#define MAX_RPM 1544
#define MIN_PWM 90

// ================== SENSOR / HEATER ==================
#define TEMP_PIN   4   // DS18B20 data (needs 4.7k pull-up to 3.3V)
#define HEATER_PIN 5   // heater's own relay

// Most 8-channel relay boards switch ON when the input is LOW.
// If your relays are inverted (ON when they should be OFF), flip these.
#define RELAY_ACTIVE_LOW  true
#define HEATER_ACTIVE_LOW true

// ================== DEVICES ==================
enum DevType { RELAY, MOTOR };

struct Device {
  const char* id;       // used in serial + web commands
  const char* label;    // shown on web page
  DevType type;
  uint8_t pin;          // relay pin, or EN (PWM) pin for motors
  uint8_t inA, inB;     // motor direction pins (unused for relays)
  bool activeLow;
  bool on;
  bool timed;
  unsigned long startMs;
  unsigned long durMs;
  uint16_t rpm;         // motors only, 0-MAX_RPM
};

uint8_t rpmToPwm(uint16_t rpm) {
  if (rpm == 0) return 0;
  if (rpm >= MAX_RPM) return 255;
  return MIN_PWM + (uint32_t)rpm * (255 - MIN_PWM) / MAX_RPM;
}

Device devs[] = {
  // id            label            type   pin  inA  inB  activeLow           on     timed  start dur rpm
  {"dispenser1",  "Dispenser 1",   RELAY, 22,  0,   0,   RELAY_ACTIVE_LOW,  false, false, 0,   0,  0},   // relay IN8
  {"dispenser2",  "Dispenser 2",   RELAY, 21,  0,   0,   RELAY_ACTIVE_LOW,  false, false, 0,   0,  0},   // relay IN7
  {"reactorpump", "Reactor Pump",  RELAY, 19,  0,   0,   RELAY_ACTIVE_LOW,  false, false, 0,   0,  0},   // relay IN6
  {"pumpin",      "Pump In",       RELAY, 18,  0,   0,   RELAY_ACTIVE_LOW,  false, false, 0,   0,  0},   // relay IN5
  {"oil",         "Oil",           RELAY, 25,  0,   0,   RELAY_ACTIVE_LOW,  false, false, 0,   0,  0},   // relay IN4
  {"pumpout",     "Pump Out",      RELAY, 26,  0,   0,   RELAY_ACTIVE_LOW,  false, false, 0,   0,  0},   // relay IN3
  {"valve",       "Valve",         RELAY, 27,  0,   0,   RELAY_ACTIVE_LOW,  false, false, 0,   0,  0},   // relay IN2
  {"electrode",   "Electrode",     RELAY, 13,  0,   0,   RELAY_ACTIVE_LOW,  false, false, 0,   0,  0},   // relay IN1
  {"heater",      "Heater",        RELAY, HEATER_PIN, 0, 0, HEATER_ACTIVE_LOW, false, false, 0, 0, 0},
  {"mixer1",      "Mixer 1",       MOTOR, ENB, IN3, IN4, false,             false, false, 0,   0,  MAX_RPM},
  {"mixer2",      "Mixer 2",       MOTOR, ENA, IN1, IN2, false,             false, false, 0,   0,  MAX_RPM},
};
const int DEV_COUNT = sizeof(devs) / sizeof(devs[0]);

WebServer server(80);
OneWire oneWire(TEMP_PIN);
DallasTemperature tempSensor(&oneWire);
float temperatureC = NAN;
unsigned long lastTempMs = 0;
String serialBuf;
bool wifiWasConnected = false;
String statusJson();   // defined further down

// ================== DEVICE CONTROL ==================
void applyDevice(Device& d) {
  if (d.type == RELAY) {
    bool level = d.on ? !d.activeLow : d.activeLow;
    digitalWrite(d.pin, level ? HIGH : LOW);
  } else {
    if (d.on) {
      digitalWrite(d.inA, HIGH);
      digitalWrite(d.inB, LOW);
      analogWrite(d.pin, rpmToPwm(d.rpm));
    } else {
      digitalWrite(d.inA, LOW);
      digitalWrite(d.inB, LOW);
      analogWrite(d.pin, 0);
    }
  }
}

// durSec = 0 -> stays on until turned off
void setDevice(Device& d, bool on, unsigned long durSec = 0) {
  d.on = on;
  d.timed = on && durSec > 0;
  d.startMs = millis();
  d.durMs = durSec * 1000UL;
  applyDevice(d);

  Serial.print(d.label);
  Serial.print(on ? " -> ON" : " -> OFF");
  if (d.timed) { Serial.print(" for "); Serial.print(durSec); Serial.print(" s"); }
  Serial.println();
}

void allOff() {
  for (int i = 0; i < DEV_COUNT; i++) setDevice(devs[i], false);
}

Device* findDevice(String id) {
  id.toLowerCase();
  for (int i = 0; i < DEV_COUNT; i++)
    if (id == devs[i].id) return &devs[i];
  return nullptr;
}

unsigned long remainingSec(const Device& d) {
  if (!d.on || !d.timed) return 0;
  unsigned long elapsed = millis() - d.startMs;
  if (elapsed >= d.durMs) return 0;
  return (d.durMs - elapsed + 999) / 1000;
}

void checkTimers() {
  for (int i = 0; i < DEV_COUNT; i++) {
    Device& d = devs[i];
    if (d.on && d.timed && millis() - d.startMs >= d.durMs) {
      Serial.print("[timer] ");
      setDevice(d, false);
    }
  }
}

// ================== TEMPERATURE ==================
void updateTemperature() {
  if (millis() - lastTempMs < 1000) return;
  lastTempMs = millis();
  float t = tempSensor.getTempCByIndex(0);
  temperatureC = (t == DEVICE_DISCONNECTED_C) ? NAN : t;
  tempSensor.requestTemperatures();   // start next conversion (non-blocking)
}

// ================== SERIAL ==================
void printHelp() {
  Serial.println(F("\n===== COMMANDS ====="));
  Serial.println(F("<device> on            -> turn on (stays on)"));
  Serial.println(F("<device> on <seconds>  -> turn on, auto-off after seconds"));
  Serial.println(F("<device> off           -> turn off"));
  Serial.println(F("mixer1 rpm <0-1544>    -> set mixer speed in RPM (also mixer2)"));
  Serial.println(F("mixer1 on <sec> <rpm>  -> run mixer at RPM for seconds (sec 0 = no timer)"));
  Serial.println(F("alloff                 -> everything off"));
  Serial.println(F("status                 -> show all states"));
  Serial.println(F("temp                   -> read temperature"));
  Serial.println(F("ip                     -> show web address"));
  Serial.println(F("json                   -> one-line status for programs: STATUS {...}"));
  Serial.println(F("help                   -> this list"));
  Serial.print(F("Devices: "));
  for (int i = 0; i < DEV_COUNT; i++) { Serial.print(devs[i].id); Serial.print(i < DEV_COUNT - 1 ? ", " : "\n"); }
  Serial.println(F("Example: pumpin on 30"));
}

void printIP() {
  if (WiFi.status() != WL_CONNECTED) { Serial.println("WiFi not connected"); return; }
  Serial.print("Web interface: http://");
  Serial.println(WiFi.localIP());
}

void printStatus() {
  Serial.println(F("\n----- STATUS -----"));
  for (int i = 0; i < DEV_COUNT; i++) {
    Device& d = devs[i];
    Serial.printf("%-13s %s", d.label, d.on ? "ON " : "OFF");
    if (d.timed && d.on) Serial.printf("  (%lu s left)", remainingSec(d));
    if (d.type == MOTOR) Serial.printf("  %u rpm (pwm %d)", d.rpm, rpmToPwm(d.rpm));
    Serial.println();
  }
  if (isnan(temperatureC)) Serial.println("Temp: sensor not found");
  else Serial.printf("Temp: %.2f C\n", temperatureC);
}

void handleSerialLine(String line) {
  line.trim();
  line.toLowerCase();
  if (line.length() == 0) return;

  // split into up to 4 words
  String w[4];
  int n = 0, start = 0;
  while (n < 4 && start < (int)line.length()) {
    int sp = line.indexOf(' ', start);
    if (sp < 0) sp = line.length();
    if (sp > start) w[n++] = line.substring(start, sp);
    start = sp + 1;
  }

  if (w[0] == "help")   { printHelp(); return; }
  if (w[0] == "status") { printStatus(); return; }
  if (w[0] == "alloff") { allOff(); return; }
  if (w[0] == "ip")     { printIP(); return; }
  if (w[0] == "json")   { Serial.print("STATUS "); Serial.println(statusJson()); return; }
  if (w[0] == "temp") {
    if (isnan(temperatureC)) Serial.println("Temp: sensor not found");
    else Serial.printf("Temp: %.2f C\n", temperatureC);
    return;
  }

  Device* d = findDevice(w[0]);
  if (!d) { Serial.println("Unknown command. Type: help"); return; }

  if (w[1] == "on") {
    long sec = (n >= 3) ? w[2].toInt() : 0;
    if (sec < 0) sec = 0;
    if (d->type == MOTOR && n >= 4) d->rpm = constrain(w[3].toInt(), 0, MAX_RPM);
    setDevice(*d, true, sec);
    if (d->type == MOTOR) Serial.printf("%s at %u rpm\n", d->label, d->rpm);
  } else if (w[1] == "off") {
    setDevice(*d, false);
  } else if ((w[1] == "rpm" || w[1] == "speed") && d->type == MOTOR && n >= 3) {
    d->rpm = constrain(w[2].toInt(), 0, MAX_RPM);
    applyDevice(*d);
    Serial.printf("%s speed = %u rpm (pwm %d)%s\n", d->label, d->rpm, rpmToPwm(d->rpm),
                  d->on ? "" : "  [motor is OFF, will use this when turned on]");
  } else {
    Serial.println("Use: <device> on [seconds] | off   |   mixer rpm <0-1544>");
  }
}

void readSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (serialBuf.length()) handleSerialLine(serialBuf);
      serialBuf = "";
    } else if (serialBuf.length() < 64) {
      serialBuf += c;
    }
  }
}

// ================== WEB ==================
const char PAGE[] PROGMEM = R"rawliteral(
<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESP32 Control</title>
<style>
body{font-family:Arial,sans-serif;background:#eef1f5;margin:0;padding:12px;color:#222}
h1{font-size:20px;margin:4px 0 12px}
.top{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.temp{background:#fff;padding:9px 14px;border-radius:8px;font-size:18px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}
.card{background:#fff;border-radius:10px;padding:12px;box-shadow:0 1px 3px rgba(0,0,0,.1);border-left:6px solid #bbb}
.card.on{border-left-color:#2e7d32}
.name{font-weight:bold;display:flex;justify-content:space-between;align-items:center}
.st{font-size:12px;padding:2px 9px;border-radius:10px;background:#ddd}
.on .st{background:#2e7d32;color:#fff}
.row{display:flex;gap:6px;margin-top:9px;align-items:center}
button{flex:1;padding:10px;border:0;border-radius:6px;font-size:15px;cursor:pointer;color:#fff}
.b-on{background:#2e7d32}.b-off{background:#c62828}.b-run{background:#1565c0}
.alloff{background:#111;flex:0 0 auto;padding:10px 18px}
input[type=number]{width:80px;padding:9px;border:1px solid #ccc;border-radius:6px;font-size:15px}
input[type=range]{flex:1}
.lbl{font-size:13px;color:#555}
.spd{font-size:14px;margin-top:10px;color:#333}
.rem{font-size:13px;color:#1565c0;min-height:16px;margin-top:6px}
</style></head><body>
<h1>ESP32 Process Control</h1>
<div class="top">
  <div class="temp">Temperature: <b id="t">--</b> &deg;C</div>
  <button class="alloff" onclick="api('/api/alloff')">ALL OFF</button>
</div>
<div class="grid" id="g"></div>
<script>
let built=false;
function api(u){return fetch(u).then(r=>r.json()).then(render).catch(()=>{});}
function setDev(id,s){api('/api/set?dev='+id+'&state='+s);}
function runDev(id){
  const v=parseInt(document.getElementById('d_'+id).value);
  if(!(v>0)){alert('Enter duration in seconds');return;}
  api('/api/set?dev='+id+'&state=on&dur='+v);
}
let maxRpm=1544;
function spd(id,v){
  v=Math.max(0,Math.min(maxRpm,parseInt(v)||0));
  document.getElementById('sl_'+id).value=v;
  document.getElementById('rn_'+id).value=v;
  api('/api/speed?dev='+id+'&rpm='+v);
}
function build(devs){
  let h='';
  devs.forEach(d=>{
    h+='<div class="card" id="c_'+d.id+'">'+
      '<div class="name">'+d.label+'<span class="st" id="s_'+d.id+'">OFF</span></div>'+
      '<div class="row"><button class="b-on" onclick="setDev(\''+d.id+'\',\'on\')">ON</button>'+
      '<button class="b-off" onclick="setDev(\''+d.id+'\',\'off\')">OFF</button></div>'+
      '<div class="row"><input type="number" min="1" placeholder="sec" id="d_'+d.id+'">'+
      '<button class="b-run" onclick="runDev(\''+d.id+'\')">ON for duration</button></div>';
    if(d.type=='motor'){
      h+='<div class="spd">Speed: <b id="sv_'+d.id+'">'+d.rpm+'</b> / '+maxRpm+' RPM</div>'+
        '<div class="row"><input type="range" min="0" max="'+maxRpm+'" step="1" value="'+d.rpm+'" id="sl_'+d.id+'" '+
        'oninput="document.getElementById(\'rn_'+d.id+'\').value=this.value" '+
        'onchange="spd(\''+d.id+'\',this.value)"></div>'+
        '<div class="row"><input type="number" min="0" max="'+maxRpm+'" value="'+d.rpm+'" id="rn_'+d.id+'">'+
        '<button class="b-run" onclick="spd(\''+d.id+'\',document.getElementById(\'rn_'+d.id+'\').value)">Set RPM</button></div>';
    }
    h+='<div class="rem" id="r_'+d.id+'"></div></div>';
  });
  document.getElementById('g').innerHTML=h;
  built=true;
}
function render(s){
  if(!s||!s.devices)return;
  if(s.maxRpm)maxRpm=s.maxRpm;
  if(!built)build(s.devices);
  document.getElementById('t').textContent=(s.temp===null)?'--':s.temp.toFixed(1);
  s.devices.forEach(d=>{
    document.getElementById('c_'+d.id).className='card'+(d.on?' on':'');
    document.getElementById('s_'+d.id).textContent=d.on?'ON':'OFF';
    document.getElementById('r_'+d.id).textContent=d.remaining>0?('Auto-off in '+d.remaining+' s'):'';
    if(d.type=='motor')document.getElementById('sv_'+d.id).textContent=d.rpm;
  });
}
api('/api/status');
setInterval(()=>api('/api/status'),1000);
</script></body></html>
)rawliteral";

String statusJson() {
  String j = "{\"maxRpm\":" + String(MAX_RPM) + ",\"minPwm\":" + String(MIN_PWM) + ",\"temp\":";
  j += isnan(temperatureC) ? String("null") : String(temperatureC, 2);
  j += ",\"devices\":[";
  for (int i = 0; i < DEV_COUNT; i++) {
    Device& d = devs[i];
    if (i) j += ",";
    j += "{\"id\":\"" + String(d.id) + "\",\"label\":\"" + String(d.label) + "\"";
    j += ",\"type\":\"" + String(d.type == MOTOR ? "motor" : "relay") + "\"";
    j += ",\"on\":" + String(d.on ? "true" : "false");
    j += ",\"remaining\":" + String(remainingSec(d));
    j += ",\"rpm\":" + String(d.rpm) + "}";
  }
  j += "]}";
  return j;
}

void sendStatus() { server.send(200, "application/json", statusJson()); }

void handleSet() {
  Device* d = findDevice(server.arg("dev"));
  if (!d) { server.send(404, "application/json", "{\"error\":\"unknown device\"}"); return; }
  String st = server.arg("state");
  if (st == "on") {
    long dur = server.hasArg("dur") ? server.arg("dur").toInt() : 0;
    setDevice(*d, true, dur > 0 ? dur : 0);
  } else if (st == "off") {
    setDevice(*d, false);
  }
  sendStatus();
}

void handleSpeed() {
  Device* d = findDevice(server.arg("dev"));
  if (!d || d->type != MOTOR) { server.send(404, "application/json", "{\"error\":\"not a mixer\"}"); return; }
  d->rpm = constrain(server.arg("rpm").toInt(), 0, MAX_RPM);
  applyDevice(*d);
  Serial.printf("%s speed = %u rpm (pwm %d)\n", d->label, d->rpm, rpmToPwm(d->rpm));
  sendStatus();
}

// ================== SETUP / LOOP ==================
void setup() {
  Serial.begin(115200);

  // Put every output in OFF state before anything else
  for (int i = 0; i < DEV_COUNT; i++) {
    Device& d = devs[i];
    if (d.type == RELAY) {
      digitalWrite(d.pin, d.activeLow ? HIGH : LOW);
      pinMode(d.pin, OUTPUT);
    } else {
      pinMode(d.inA, OUTPUT);
      pinMode(d.inB, OUTPUT);
      pinMode(d.pin, OUTPUT);
    }
    applyDevice(d);
  }

  tempSensor.begin();
  tempSensor.setWaitForConversion(false);
  tempSensor.requestTemperatures();

  // WiFi (station only). Waits up to 10 s, then carries on so serial
  // control works even without WiFi; it keeps reconnecting in the background.
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting to ");
  Serial.print(WIFI_SSID);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 10000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  wifiWasConnected = (WiFi.status() == WL_CONNECTED);
  if (wifiWasConnected) Serial.println("WiFi connected");
  else Serial.println("WiFi not connected yet - serial control is active, still trying WiFi");
  printIP();

  server.on("/", []() { server.send_P(200, "text/html", PAGE); });
  server.on("/api/status", sendStatus);
  server.on("/api/set", handleSet);
  server.on("/api/speed", handleSpeed);
  server.on("/api/alloff", []() { allOff(); sendStatus(); });
  server.begin();

  printHelp();
}

void checkWiFi() {
  bool now = (WiFi.status() == WL_CONNECTED);
  if (!now && wifiWasConnected) Serial.println("WiFi lost - reconnecting...");
  if (now && !wifiWasConnected) { Serial.println("WiFi connected"); printIP(); }
  wifiWasConnected = now;
}

void loop() {
  checkWiFi();
  server.handleClient();
  readSerial();
  checkTimers();
  updateTemperature();
}
