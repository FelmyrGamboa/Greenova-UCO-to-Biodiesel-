/*
  ESP32 Process Controller
  - 8-channel relay board + separate heater relay
  - 4-channel relay board (replaces the L298N) - simple ON/OFF
  - DS18B20 temperature sensor
  - Serial commands + web interface (ON / OFF / timed ON per device)

  Libraries (Library Manager): OneWire, DallasTemperature
  Board: ESP32 Dev Module (ESP32 Arduino core 2.x or 3.x)

  PIN NOTE: GPIO 13 was used by "Electrode" (8-ch relay IN1). Since the
            4-ch relay IN3 now uses GPIO 13, Electrode was moved to GPIO 32.
            Rewire 8-ch relay IN1 to GPIO 32 (or change ELECTRODE_PIN).
*/

#include <WiFi.h>
#include <WebServer.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// ================== WIFI ==================
const char* WIFI_SSID = "GlobeAtHome_defc0";
const char* WIFI_PASS = "ertRR6nt";

// ================== 4-CHANNEL RELAY ==================
#define R4_IN1 16   // Mixer 1   (RX2)
#define R4_IN2 17   // Mixer 2   (TX2)
#define R4_IN3 13   // Centrifuge
#define R4_IN4 14   // Extra

// ================== SENSOR / HEATER / MOVED PIN ==================
#define TEMP_PIN      15   // DS18B20 data (needs 4.7k pull-up to 3.3V)
#define HEATER_PIN    5    // heater's own relay
#define ELECTRODE_PIN 32   // moved from 13 (now used by 4-ch relay IN3)

// Most relay boards switch ON when the input is LOW.
// If a board's relays are inverted (ON when they should be OFF), flip its setting.
#define RELAY_ACTIVE_LOW   false   // 8-channel board
#define RELAY4_ACTIVE_LOW  true   // 4-channel board
#define HEATER_ACTIVE_LOW  false   // heater relay

// ================== DEVICES ==================
struct Device {
  const char* id;       // used in serial + web commands
  const char* label;    // shown on web page
  uint8_t pin;
  bool activeLow;
  bool on;
  bool timed;
  unsigned long startMs;
  unsigned long durMs;
};

Device devs[] = {
  // id            label            pin            activeLow           on     timed  start dur
  // ---- 8-channel relay board ----
  {"dispenser1",  "Dispenser 1",   22,            RELAY_ACTIVE_LOW,   false, false, 0,    0},   // IN8
  {"dispenser2",  "Dispenser 2",   21,            RELAY_ACTIVE_LOW,   false, false, 0,    0},   // IN7
  {"reactorpump", "Reactor Pump",  19,            RELAY_ACTIVE_LOW,   false, false, 0,    0},   // IN6
  {"pumpin",      "Pump In",       18,            RELAY_ACTIVE_LOW,   false, false, 0,    0},   // IN5
  {"oil",         "Oil",           25,            RELAY_ACTIVE_LOW,   false, false, 0,    0},   // IN4
  {"pumpout",     "Pump Out",      26,            RELAY_ACTIVE_LOW,   false, false, 0,    0},   // IN3
  {"valve",       "Valve",         27,            RELAY_ACTIVE_LOW,   false, false, 0,    0},   // IN2
  {"electrode",   "Electrode",     ELECTRODE_PIN, RELAY_ACTIVE_LOW,   false, false, 0,    0},   // IN1
  // ---- heater relay ----
  {"heater",      "Heater",        HEATER_PIN,    HEATER_ACTIVE_LOW,  false, false, 0,    0},
  // ---- 4-channel relay board ----
  {"mixer1",      "Mixer 1",       R4_IN1,        RELAY4_ACTIVE_LOW,  false, false, 0,    0},   // IN1
  {"mixer2",      "Mixer 2",       R4_IN2,        RELAY4_ACTIVE_LOW,  false, false, 0,    0},   // IN2
  {"extra",  "Extra",    R4_IN3,        RELAY4_ACTIVE_LOW,  false, false, 0,    0},   // IN3
  {"centrifuge",       "Centrifuge",         R4_IN4,        RELAY4_ACTIVE_LOW,  false, false, 0,    0},   // IN4
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
  bool level = d.on ? !d.activeLow : d.activeLow;
  digitalWrite(d.pin, level ? HIGH : LOW);
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
  Serial.println(F("alloff                 -> everything off"));
  Serial.println(F("status                 -> show all states"));
  Serial.println(F("temp                   -> read temperature"));
  Serial.println(F("ip                     -> show web address"));
  Serial.println(F("json                   -> one-line status for programs: STATUS {...}"));
  Serial.println(F("help                   -> this list"));
  Serial.print(F("Devices: "));
  for (int i = 0; i < DEV_COUNT; i++) { Serial.print(devs[i].id); Serial.print(i < DEV_COUNT - 1 ? ", " : "\n"); }
  Serial.println(F("Example: mixer1 on 30"));
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
    Serial.println();
  }
  if (isnan(temperatureC)) Serial.println("Temp: sensor not found");
  else Serial.printf("Temp: %.2f C\n", temperatureC);
}

void handleSerialLine(String line) {
  line.trim();
  line.toLowerCase();
  if (line.length() == 0) return;

  // split into up to 3 words
  String w[3];
  int n = 0, start = 0;
  while (n < 3 && start < (int)line.length()) {
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
    setDevice(*d, true, sec);
  } else if (w[1] == "off") {
    setDevice(*d, false);
  } else {
    Serial.println("Use: <device> on [seconds] | off");
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
function build(devs){
  let h='';
  devs.forEach(d=>{
    h+='<div class="card" id="c_'+d.id+'">'+
      '<div class="name">'+d.label+'<span class="st" id="s_'+d.id+'">OFF</span></div>'+
      '<div class="row"><button class="b-on" onclick="setDev(\''+d.id+'\',\'on\')">ON</button>'+
      '<button class="b-off" onclick="setDev(\''+d.id+'\',\'off\')">OFF</button></div>'+
      '<div class="row"><input type="number" min="1" placeholder="sec" id="d_'+d.id+'">'+
      '<button class="b-run" onclick="runDev(\''+d.id+'\')">ON for duration</button></div>'+
      '<div class="rem" id="r_'+d.id+'"></div></div>';
  });
  document.getElementById('g').innerHTML=h;
  built=true;
}
function render(s){
  if(!s||!s.devices)return;
  if(!built)build(s.devices);
  document.getElementById('t').textContent=(s.temp===null)?'--':s.temp.toFixed(1);
  s.devices.forEach(d=>{
    document.getElementById('c_'+d.id).className='card'+(d.on?' on':'');
    document.getElementById('s_'+d.id).textContent=d.on?'ON':'OFF';
    document.getElementById('r_'+d.id).textContent=d.remaining>0?('Auto-off in '+d.remaining+' s'):'';
  });
}
api('/api/status');
setInterval(()=>api('/api/status'),1000);
</script></body></html>
)rawliteral";

String statusJson() {
  String j = "{\"temp\":";
  j += isnan(temperatureC) ? String("null") : String(temperatureC, 2);
  j += ",\"devices\":[";
  for (int i = 0; i < DEV_COUNT; i++) {
    Device& d = devs[i];
    if (i) j += ",";
    j += "{\"id\":\"" + String(d.id) + "\",\"label\":\"" + String(d.label) + "\"";
    j += ",\"on\":" + String(d.on ? "true" : "false");
    j += ",\"remaining\":" + String(remainingSec(d)) + "}";
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

// ================== SETUP / LOOP ==================
void setup() {
  Serial.begin(115200);

  // Put every output in OFF state before anything else
  for (int i = 0; i < DEV_COUNT; i++) {
    Device& d = devs[i];
    digitalWrite(d.pin, d.activeLow ? HIGH : LOW);
    pinMode(d.pin, OUTPUT);
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
