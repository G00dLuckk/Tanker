/**
 * The decoder of the payload script, as plain ES5 source, in parts, so each device
 * model only carries the sensors of its family (§11 of the site brief: one model per
 * sensor family, never both address kinds in one model):
 *
 * LoRaWAN family (DevEUI)
 *   FPORT 2 / 3 / 5     Dragino MR-03 / MR-12 / MR-25-LB radar, DDS20 / DDS45 / DDS75-LB, LDDS ultrasonic
 *   FPORT 85            Milesight EM310-UDL, EM400-UDL / MUD, EM410-RDL, EM500-UDL
 *   FPORT 6             Netvox R718X / R718PE
 *   first byte 10 / 30 / 45 / 43 / 47 and a Tekelek product byte
 *                       Rochester / Tekelek TEK 766 and the other Tekelek LoRaWAN sensors
 *   an object already decoded by the network server (TTN payload formatter, ChirpStack codec)
 *
 * TCP family (IMEI, SIM card sensors)
 *   first byte 07 / 08, IMEI in bytes 7-14 (binary or hex text)
 *                       Rochester / Tekelek TEK 811 / 811 LR / 822 (4G NB-IoT / CAT-M1), manual 9-5987-03
 *   IMEI in bytes 9-16, CRC-16 at the end (binary or hex text)
 *                       the newer Rochester / Tekelek cellular frame (first seen with product byte 0x22):
 *                       6-byte readings from byte 46 with the ullage in mm
 *   JSON text           distance in mm, or ullage / distance in cm
 *
 * decodeReading(payload) returns { model, distance (mm), battery, temperature, invalid, skip, info }:
 *   invalid  why the reading cannot give a level (the sensor itself says so)
 *   skip     why the uplink holds no reading (status, history, settings reply…)
 *
 * Payload formats come from the makers' documents: the Dragino MRxx-LB / DDS20-LB
 * decoders and wiki, the Tekelek "Ultrasonic LoRaWAN User Manual" V1.3 (TEK 766) and
 * "Ultrasonic NB-IoT / CAT-M1 User Manual" 9-5987-03 (TEK 811), the
 * Milesight EM310 / EM400 / EM410 / EM500 codecs and the Netvox R718X / R718PE codecs.
 * Byte offsets, scalings and signs are kept exactly as in those documents.
 *
 * The newer Tekelek cellular frame has no public manual. Its layout was read from frames a
 * sensor sent to the platform: the frame ends with CRC-16/XMODEM of everything before it,
 * the IMEI sits in bytes 9-16 (BCD, as in the TEK 811 header, two bytes later), and from
 * byte 46 come 6-byte readings, newest first: two status bytes, the temperature (signed, C),
 * SRC / SRSSI nibbles (as in the TEK 766 frame) and the ullage in mm (16 bits, big endian).
 * The battery byte of this frame is not known, so no battery is reported for it.
 */

export type DecoderFamily = 'lorawan' | 'tcp';

const COMMON = `function result(model)
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
`;

const HEX_TEXT = `function fromHexText(bytes)
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
`;

const DRAGINO = `var DRAGINO_MODELS = { 0x2A: "Dragino MR-xx-LB", 0x29: "Dragino DDS20-LB" };

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
`;

/** Shared by the TEK 766 (LoRaWAN) and TEK 811 (TCP) decoders: quality limits and their meaning. */
const TEKELEK_COMMON = `var MIN_SRC = 8;
var MIN_SRSSI = 4;
var TEK_PRODUCTS = { 0: "TEK 766", 2: "TEK 586", 3: "TEK 790", 5: "TEK 733", 6: "TEK 643", 7: "TEK 811", 8: "TEK 822", 9: "TEK 733A" };
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

function tekelekQuality(r, ullage, src, srssi)
{
  if (src < MIN_SRC)
    r.invalid = "SRC " + src + " = " + (SRC_TEXT[src] || "unknown code");
  else if (srssi < MIN_SRSSI)
    r.invalid = "SRSSI " + srssi + " is below " + MIN_SRSSI + ", weak echo";
  else if (ullage == 0)
    r.invalid = "0 = no reading";
}
`;

const TEK766 = `var TEK_TYPES = { 0x10: "measurement", 0x30: "status", 0x45: "alarm", 0x43: "parameter read response", 0x47: "diagnostic read response" };
var CONTACT_TEXT = ["reset", "scheduled", "manual (button)", "activation"];
var RESET_TEXT = ["power on", "brown out", "external", "watchdog", "lockup", "system request", "EM4", "backup mode"];

function alarmText(flags)
{
  var list = [];
  if (flags & 0x01) list.push("limit 1");
  if (flags & 0x02) list.push("limit 2");
  if (flags & 0x04) list.push("limit 3");
  return (list.length > 0) ? list.join(", ") : "none";
}

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
    var flags = bytes[2] & 0x07;
    if (type == 0x45)
      text = "ALARM " + alarmText(flags);
    else if (flags != 0)
      text += ", alarm flags " + alarmText(flags);
    at = 4;
  }
  else if (type == 0x30) {
    if (bytes.length >= 11) {
      r.battery = { percentage: bytes[10] };
      var contact = bytes[6] & 0x03;
      text += ", firmware " + bytes[4] + "." + bytes[5] + ", contact " + CONTACT_TEXT[contact];
      if (contact == 0)
        text += " (" + RESET_TEXT[(bytes[6] >> 2) & 0x07] + " reset)";
      text += ", RSSI -" + bytes[8] + " dBm";
      if (((bytes[6] >> 5) & 0x01) == 0)
        text += ", device is going DORMANT";
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
  tekelekQuality(r, ullage, src, srssi);
  return r;
}
`;

const TEK811 = `var TEK811_TYPES = { 4: "scheduled reading", 8: "ALARM" };

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
  tekelekQuality(r, ullage, src, srssi);
  return r;
}
`;

const TEK_CELL = `var TEK_CELL_IMEI = 9;
var TEK_CELL_BODY = 19;
var TEK_CELL_READINGS = 46;
var TEK_CELL_READING_SIZE = 6;

function bcdImeiAt(bytes, at)
{
  if (bytes.length < at + 8 || (bytes[at] >> 4) != 0)
    return false;
  for (var i = at; i < at + 8; i++) {
    if ((bytes[i] >> 4) > 9 || (bytes[i] & 0x0f) > 9)
      return false;
  }
  return true;
}

function crc16(bytes, count)
{
  var crc = 0;
  for (var i = 0; i < count; i++) {
    crc ^= (bytes[i] & 0xff) << 8;
    for (var k = 0; k < 8; k++)
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function tekCellChecksumOk(bytes)
{
  var end = bytes.length - 2;
  return end > 0 && crc16(bytes, end) == readUInt(bytes, end, 2, "be");
}

function isTekCell(bytes)
{
  if (bytes.length < TEK_CELL_BODY + 2 || !bcdImeiAt(bytes, TEK_CELL_IMEI))
    return false;
  if (tekCellChecksumOk(bytes))
    return true;
  return !(isTek811(bytes) && bcdImeiAt(bytes, 7));
}

function decodeTekCell(bytes)
{
  var r = result("Tekelek " + (TEK_PRODUCTS[bytes[0]] || "sensor 0x" + hex2(bytes[0])));
  var end = bytes.length - 2;
  var note = tekCellChecksumOk(bytes) ? "" : ", checksum does not match (frame cut short or joined)";
  var printable = 0;
  for (var i = TEK_CELL_BODY; i < end; i++) {
    if (bytes[i] >= 0x20 && bytes[i] <= 0x7e)
      printable++;
  }
  if (printable >= (end - TEK_CELL_BODY) * 0.9) {
    r.skip = "settings or information message, ignored" + note;
    return r;
  }
  for (var at = TEK_CELL_READINGS; at + TEK_CELL_READING_SIZE <= end; at += TEK_CELL_READING_SIZE) {
    var empty = true;
    for (var k = 0; k < TEK_CELL_READING_SIZE; k++) {
      if (bytes[at + k] != 0)
        empty = false;
    }
    if (empty)
      continue;
    var ullage = readUInt(bytes, at + 4, 2, "be");
    var src = bytes[at + 3] >> 4;
    var srssi = bytes[at + 3] & 0x0f;
    r.distance = ullage;
    r.temperature = signed8(bytes[at + 2]);
    r.info = "ullage " + ullage + " mm, SRC " + src + ", SRSSI " + srssi + ", temperature " + r.temperature + " C" + note;
    tekelekQuality(r, ullage, src, srssi);
    return r;
  }
  r.skip = "no measurement in the frame (" + bytes.length + " bytes)" + note;
  return r;
}
`;

const MILESIGHT = `var MILESIGHT_LENGTHS = {
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
`;

const NETVOX = `var NETVOX_DEVICES = { 0x34: "Netvox R718X", 0xB1: "Netvox R718PE" };

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
`;

const OBJECT = `var DISTANCE_KEYS = ["distance", "Distance", "distance_mm", "distanceMm", "ullage_mm", "level_distance"];
var CM_KEYS = ["ullage_cm", "ullage", "distance_cm", "distanceCm"];
var BATTERY_KEYS = ["battery", "Bat", "BatV", "battery_voltage", "batteryVoltage"];
var TEMPERATURE_KEYS = ["temperature", "Temperature", "temp", "TempC_SHT", "temperature_c"];

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
    r.skip = "no decoded object";
    return r;
  }
  var mm = findNumber(data, DISTANCE_KEYS);
  var cm = (mm == null) ? findNumber(data, CM_KEYS) : null;
  var battery = findNumber(data, BATTERY_KEYS);
  var temperature = findNumber(data, TEMPERATURE_KEYS);
  if (battery != null) r.battery = (battery <= 5) ? { voltage: battery } : { percentage: battery };
  if (temperature != null) r.temperature = temperature;
  if (mm != null) r.distance = mm;
  else if (cm != null) r.distance = cm * 10;
  else r.skip = "no distance in the decoded payload";
  return r;
}

function emptyReading(payload)
{
  var r = decodeObject(payload, null);
  if (r.distance == null) {
    r.model = "Empty payload";
    r.skip = "no bytes and no decoded object on FPORT " + payload.port;
  }
  return r;
}
`;

const DISPATCH_LORAWAN = `function decodeReading(payload)
{
  var bytes = null;
  try { bytes = payload.asBytes(); } catch (e) { bytes = null; }
  if (bytes == null || bytes.length == 0)
    return emptyReading(payload);
  if (bytes[0] == 0x7b || bytes[0] == 0x5b)
    return decodeObject(payload, bytes);
  var port = payload.port;
  if (port == 85) return decodeMilesight(bytes, port);
  if (port == 6) return decodeNetvox(bytes, port);
  if (port == 2 || port == 3 || port == 5) return decodeDragino(bytes, port);
  if (isTekelek(bytes)) return decodeTekelek(bytes, port);
  var r = decodeObject(payload, null);
  if (r.distance == null) {
    r.model = "Unknown message type";
    r.skip = ((port != null) ? "FPORT " + port + ", payload " : "payload ") + toHex(bytes) + " is not a known distance sensor";
  }
  return r;
}
`;

const DISPATCH_TCP = `function decodeReading(payload)
{
  var bytes = null;
  try { bytes = payload.asBytes(); } catch (e) { bytes = null; }
  if (bytes == null || bytes.length == 0)
    return emptyReading(payload);
  if (bytes[0] == 0x7b || bytes[0] == 0x5b)
    return decodeObject(payload, bytes);
  bytes = fromHexText(bytes);
  if (isTekCell(bytes)) return decodeTekCell(bytes);
  if (isTek811(bytes)) return decodeTek811(bytes);
  var r = decodeObject(payload, null);
  if (r.distance == null) {
    r.model = "Unknown message type";
    r.skip = "payload " + toHex(bytes) + " is not a known TCP sensor frame";
  }
  return r;
}
`;

/** The decoder of one sensor family, as ES5 source. */
export function decoderSource(family: DecoderFamily): string {
  const parts =
    family === 'tcp'
      ? [COMMON, HEX_TEXT, TEKELEK_COMMON, TEK811, TEK_CELL, OBJECT, DISPATCH_TCP]
      : [COMMON, DRAGINO, TEKELEK_COMMON, TEK766, MILESIGHT, NETVOX, OBJECT, DISPATCH_LORAWAN];
  return parts.join('\n');
}

/** The LoRaWAN decoder (kept for callers that only need one). */
export const DECODER = decoderSource('lorawan');
