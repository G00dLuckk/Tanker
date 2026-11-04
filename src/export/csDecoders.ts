/**
 * The decoder of the payload script, as plain ES5 source. It works out from each
 * uplink which sensor sent it, so every ultrasonic or radar distance sensor on the
 * site works without choosing a model:
 *
 *   FPORT 2 / 3 / 5     Dragino MR-03 / MR-12 / MR-25-LB radar, DDS20 / DDS45 / DDS75-LB, LDDS ultrasonic
 *   FPORT 85            Milesight EM310-UDL, EM400-UDL / MUD, EM410-RDL, EM500-UDL
 *   FPORT 6             Netvox R718X / R718PE
 *   first byte 10 / 30 / 45 / 43 / 47 and a Tekelek product byte
 *                       Rochester / Tekelek TEK 766 and the other Tekelek LoRaWAN sensors
 *   first byte 07 / 08, 17+ bytes (binary or hex text, over TCP)
 *                       Rochester / Tekelek TEK 811 / 811 LR / 822 (4G NB-IoT / CAT-M1, IMEI)
 *   JSON text or an object already decoded by the network server (SIM card devices over
 *   TCP / MQTT / HTTP, TTN payload formatter, ChirpStack codec): distance in mm, or
 *   ullage / distance in cm
 *
 * decodeReading(payload) returns { model, distance (mm), battery, temperature, invalid, skip, info }:
 *   invalid  why the reading cannot give a level (the sensor itself says so)
 *   skip     why the uplink holds no reading (status, history, settings reply…)
 *
 * Payload formats come from the makers' documents: the Dragino MRxx-LB / DDS20-LB
 * decoders and wiki, the Tekelek "Ultrasonic LoRaWAN User Manual" (TEK 766) and
 * "Ultrasonic NB-IoT / CAT-M1 User Manual" 9-5987-03 (TEK 811), the
 * Milesight EM310 / EM400 / EM410 / EM500 codecs and the Netvox R718X / R718PE codecs.
 */
export const DECODER = `function result(model)
{
  return { model: model, distance: null, battery: null, temperature: null, invalid: null, skip: null, info: null };
}

function hex2(value)
{
  var s = value.toString(16);
  return (s.length < 2) ? "0" + s : s;
}

function toHex(bytes)
{
  var s = "";
  for (var i = 0; i < bytes.length; i++)
    s += hex2(bytes[i]);
  return s;
}

function readUInt(bytes, i, size, order)
{
  var v = 0;
  for (var k = 0; k < size; k++)
    v = v * 256 + (bytes[order == "le" ? i + size - 1 - k : i + k] & 0xff);
  return v;
}

function signed8(v)
{
  return (v > 127) ? v - 256 : v;
}

function textOf(bytes)
{
  var s = "";
  for (var i = 0; i < bytes.length; i++)
    s += String.fromCharCode(bytes[i]);
  return s;
}

function fromHexText(bytes)
{
  if (bytes.length < 34 || bytes.length % 2 != 0)
    return bytes;
  var text = textOf(bytes);
  if (!/^[0-9A-Fa-f]+$/.test(text))
    return bytes;
  var out = [];
  for (var i = 0; i < text.length; i += 2)
    out.push(parseInt(text.substr(i, 2), 16));
  return out;
}

var DRAGINO_MODELS = { 0x2A: "Dragino MR-xx-LB", 0x29: "Dragino DDS20-LB" };

function decodeDragino(bytes, port)
{
  var r = result("Dragino");
  if (port == 5) {
    if (bytes.length >= 7) r.battery = { voltage: (readUInt(bytes, 5, 2, "be") & 0x3fff) / 1000 };
    var model = DRAGINO_MODELS[bytes[0]];
    if (model) r.model = model;
    r.skip = "device status packet" + (model ? ", firmware " + (bytes[1] & 0x0f) + "." + (bytes[2] >> 4) + "." + (bytes[2] & 0x0f) : "");
    return r;
  }
  if (port == 3) {
    r.skip = "datalog (history) packet, ignored";
    return r;
  }
  if (bytes.length < 4) {
    r.skip = "payload too short (" + bytes.length + " bytes)";
    return r;
  }
  r.battery = { voltage: (readUInt(bytes, 0, 2, "be") & 0x3fff) / 1000 };
  r.distance = readUInt(bytes, 2, 2, "be");
  if (bytes.length >= 5 && bytes[4] == 1)
    r.info = "interrupt uplink";
  var flag = (bytes.length >= 8) ? bytes[7] : 1;
  if (flag != 1)
    r.invalid = "sensor flag = " + flag + " (radar or probe not detected)";
  else if (r.distance == 0)
    r.invalid = "0 = no echo (radar or probe not detected)";
  return r;
}

var MIN_SRC = 8;
var MIN_SRSSI = 4;
var TEK_TYPES = { 0x10: "measurement", 0x30: "status", 0x45: "alarm", 0x43: "parameter read response", 0x47: "diagnostic read response" };
var TEK_PRODUCTS = { 0: "TEK 766", 2: "TEK 586", 3: "TEK 790", 5: "TEK 733", 6: "TEK 643", 7: "TEK 811", 8: "TEK 822", 9: "TEK 733A" };
var CONTACT_TEXT = ["reset", "scheduled", "manual (button)", "activation"];
var SRC_TEXT = {
  0: "no echo received",
  1: "poor ultrasonic performance, damp sensor or very cold",
  2: "poor ultrasonic performance",
  3: "noisy reflections, check alignment or obstructions",
  4: "best echo is beyond the operating range",
  5: "multiple reflections near the sensor",
  6: "weak reflections, check alignment",
  7: "reflection from near the sensor, possible obstruction",
  8: "multiple reflections, reading probably correct",
  9: "good, surface very near the sensor",
  10: "good"
};

function isTekelek(bytes)
{
  return bytes.length >= 4 && TEK_TYPES[bytes[0]] != null && TEK_PRODUCTS[bytes[1]] != null;
}

function decodeTekelek(bytes, port)
{
  var r = result("Tekelek " + TEK_PRODUCTS[bytes[1]]);
  var type = bytes[0];
  var text = TEK_TYPES[type];
  var at;
  if (type == 0x10 || type == 0x45) {
    if (bytes.length < 8) {
      r.skip = text + " too short (" + bytes.length + " bytes)";
      return r;
    }
    if (bytes[2] & 0x07) text += ", alarm flags " + (bytes[2] & 0x07);
    at = 4;
  }
  else if (type == 0x30) {
    if (bytes.length >= 11) {
      r.battery = { percentage: bytes[10] };
      text += ", firmware " + bytes[4] + "." + bytes[5] + ", contact " + CONTACT_TEXT[bytes[6] & 0x03] + ", RSSI -" + bytes[8] + " dBm";
    }
    if (bytes.length < 18) {
      r.skip = text + ", no reading in frame";
      return r;
    }
    at = 14;
  }
  else {
    r.skip = text + ": " + toHex(bytes);
    return r;
  }
  var ullage = readUInt(bytes, at, 2, "be");
  var src = bytes[at + 3] >> 4;
  var srssi = bytes[at + 3] & 0x0f;
  r.distance = ullage * 10;
  r.temperature = signed8(bytes[at + 2]);
  r.info = text + ", ullage " + ullage + " cm, SRC " + src + ", SRSSI " + srssi + ", temperature " + r.temperature + " C";
  if (src < MIN_SRC)
    r.invalid = "SRC " + src + " = " + (SRC_TEXT[src] || "unknown code");
  else if (srssi < MIN_SRSSI)
    r.invalid = "SRSSI " + srssi + " is below " + MIN_SRSSI + ", weak echo";
  else if (ullage == 0)
    r.invalid = "0 = no reading";
  return r;
}

var TEK811_TYPES = { 4: "scheduled reading", 8: "ALARM" };

function isTek811(bytes)
{
  return bytes.length >= 17 && (bytes[0] == 0x07 || bytes[0] == 0x08);
}

function decodeTek811(bytes)
{
  var r = result("Tekelek " + TEK_PRODUCTS[bytes[0]]);
  r.battery = { voltage: (30 + (bytes[6] & 0x1f)) / 10 };
  var type = bytes[15] & 0x3f;
  if (TEK811_TYPES[type] == null) {
    r.skip = "message type " + type + " (settings, diagnostics or GPS), ignored";
    return r;
  }
  if (bytes.length < 30) {
    r.skip = "message type " + type + " too short (" + bytes.length + " bytes)";
    return r;
  }
  if (bytes[26] == 0 && bytes[27] == 0 && bytes[28] == 0 && bytes[29] == 0) {
    r.skip = "no measurement in the log";
    return r;
  }
  var ullage = ((bytes[28] & 0x03) << 8) | bytes[29];
  var src = (bytes[28] >> 2) & 0x0f;
  var srssi = bytes[26] & 0x0f;
  r.distance = ullage * 10;
  r.temperature = bytes[27] / 2 - 30;
  r.info = TEK811_TYPES[type] + ", ullage " + ullage + " cm, SRC " + src + ", SRSSI " + srssi + ", temperature " + r.temperature + " C";
  if (src < MIN_SRC)
    r.invalid = "SRC " + src + " = " + (SRC_TEXT[src] || "unknown code");
  else if (srssi < MIN_SRSSI)
    r.invalid = "SRSSI " + srssi + " is below " + MIN_SRSSI + ", weak echo";
  else if (ullage == 0)
    r.invalid = "0 = no reading";
  return r;
}

var MILESIGHT_LENGTHS = {
  "ff01": 1, "ff09": 2, "ff0a": 2, "ffff": 2, "ff16": 8, "ff0f": 1, "fffe": 1, "ff0b": 1,
  "ff0c": 1, "ff1b": 5, "83e9": 5, "20ce": 6, "0367": 2, "8367": 3, "0400": 1, "0500": 1, "06c7": 2,
  "02": 2, "03": 2, "06": 9, "10": 1, "11": 4, "17": 2, "1c": 2, "27": 1, "28": 1,
  "35": 8, "3b": 1, "4a": 1, "68": 1, "69": 1, "6a": 3, "84": 1, "96": 8, "f1": 4,
  "f2": 2, "f5": 1
};

function decodeMilesight(bytes, port)
{
  var r = result("Milesight");
  var notes = [];
  var raw = null;
  var history = 0;
  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];
    var key = hex2(channel) + hex2(type);
    i += 2;
    if (key == "0175") {
      if (bytes[i] <= 100) r.battery = { percentage: bytes[i] };
      i += 1;
    }
    else if (key == "0382" || key == "0482") {
      raw = readUInt(bytes, i, 2, "le");
      i += 2;
    }
    else if (key == "8482" || key == "b482") {
      raw = readUInt(bytes, i, 2, "le");
      notes.push(key == "8482" ? "distance alarm" : "distance exception");
      i += 3;
    }
    else if (key == "9482") {
      raw = readUInt(bytes, i, 2, "le");
      notes.push("distance mutation alarm");
      i += 5;
    }
    else if ((key == "0400" || key == "0500") && bytes[i] == 1) {
      notes.push("device tilted");
      i += 1;
    }
    else {
      var len = MILESIGHT_LENGTHS[key];
      if (len == null && (channel == 0xff || channel == 0xfe)) len = MILESIGHT_LENGTHS[hex2(type)];
      if (len == null) {
        notes.push("unknown channel " + key + " at byte " + (i - 2) + ", rest skipped");
        break;
      }
      if (key == "20ce") history++;
      i += len;
    }
  }
  if (notes.length) r.info = notes.join(", ");
  if (raw == null) {
    r.skip = (history > 0) ? history + " history record(s), ignored" : "no distance (device information packet)";
    return r;
  }
  if (raw == 0xfffd) r.skip = "no target / out of range";
  else if (raw == 0xffff) r.skip = "sensor error";
  else if (raw == 0xfffe) r.skip = "measurement disabled";
  else {
    r.distance = raw;
    if (raw == 0) r.invalid = "0 = no reading";
  }
  return r;
}

var NETVOX_DEVICES = { 0x34: "Netvox R718X", 0xB1: "Netvox R718PE" };

function decodeNetvox(bytes, port)
{
  var r = result(NETVOX_DEVICES[bytes[1]] || "Netvox");
  if (bytes.length < 7) {
    r.skip = "payload too short (" + bytes.length + " bytes)";
    return r;
  }
  if (bytes[2] == 0x00) {
    r.skip = "version report";
    return r;
  }
  r.battery = { voltage: (bytes[3] & 0x7f) / 10 };
  if (NETVOX_DEVICES[bytes[1]] == null) {
    r.skip = "device type 0x" + hex2(bytes[1]) + " is not a distance sensor";
    return r;
  }
  r.distance = readUInt(bytes, 5, 2, "be");
  if (bytes[3] & 0x80) r.info = "LOW BATTERY";
  if (r.distance == 0) r.invalid = "0 = no reading";
  return r;
}

var DISTANCE_KEYS = ["distance", "Distance", "distance_mm", "distanceMm", "ullage_mm", "level_distance"];
var CM_KEYS = ["ullage_cm", "ullage", "distance_cm", "distanceCm"];
var BATTERY_KEYS = ["battery", "Bat", "BatV", "battery_voltage", "batteryVoltage"];

function findNumber(data, keys)
{
  for (var depth = 0; depth < 3 && data != null && typeof data == "object"; depth++) {
    for (var i = 0; i < keys.length; i++) {
      var v = data[keys[i]];
      if (v != null && v !== "" && !isNaN(Number(v))) return Number(v);
    }
    data = data.decoded_payload || data.decoded || data.data || data.object || null;
  }
  return null;
}

function decodeObject(payload, bytes)
{
  var r = result("JSON / decoded payload");
  var data = null;
  try { data = payload.asParsedObject(); } catch (e) { data = null; }
  if (data == null || typeof data != "object") {
    try { data = payload.asJsonObject(); } catch (e2) { data = null; }
  }
  if ((data == null || typeof data != "object") && bytes != null) {
    try { data = JSON.parse(textOf(bytes)); } catch (e3) { data = null; }
  }
  if (data == null || typeof data != "object") {
    r.skip = "empty payload";
    return r;
  }
  var mm = findNumber(data, DISTANCE_KEYS);
  var cm = (mm == null) ? findNumber(data, CM_KEYS) : null;
  var battery = findNumber(data, BATTERY_KEYS);
  if (battery != null) r.battery = (battery <= 5) ? { voltage: battery } : { percentage: battery };
  if (mm != null) r.distance = mm;
  else if (cm != null) r.distance = cm * 10;
  else r.skip = "no distance in the decoded payload";
  return r;
}

function decodeReading(payload)
{
  var bytes = null;
  try { bytes = payload.asBytes(); } catch (e) { bytes = null; }
  if (bytes == null || bytes.length == 0)
    return decodeObject(payload, null);
  if (bytes[0] == 0x7b || bytes[0] == 0x5b)
    return decodeObject(payload, bytes);
  bytes = fromHexText(bytes);
  var port = payload.port;
  if (port == 85) return decodeMilesight(bytes, port);
  if (port == 6) return decodeNetvox(bytes, port);
  if (port == 2 || port == 3 || port == 5) return decodeDragino(bytes, port);
  if (isTek811(bytes)) return decodeTek811(bytes);
  if (isTekelek(bytes)) return decodeTekelek(bytes, port);
  var r = decodeObject(payload, null);
  if (r.distance == null) {
    r.model = "unknown sensor";
    r.skip = ((port != null) ? "FPORT " + port + ", payload " : "payload ") + toHex(bytes) + " is not a known distance sensor";
  }
  return r;
}
`;
