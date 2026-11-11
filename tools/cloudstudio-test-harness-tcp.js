var fs = require('fs');
var src = fs.readFileSync(process.argv[2], 'utf8') + '\n' + fs.readFileSync(process.argv[3], 'utf8');
var logs = [];
var env = { log: function (m) { logs.push(m); } };
var endpointType = { genericSensor: 'genericSensor', temperatureSensor: 'temperatureSensor' };
var downlinkBuildResult = { ok: 'ok', unsupported: 'unsupported' };
var eps = {};
var endpoints = { addEndpoint: function (a, n, t) {
  eps[a] = { address: a, name: n, type: t, value: null,
    updateGenericSensorStatus: function (v) { this.value = v; },
    updateTemperatureSensorStatus: function (v) { this.value = v; } };
  return eps[a];
} };
var device = { battery: null,
  endpoints: { byAddress: function (a) { return eps[a] || null; } },
  updateDeviceBattery: function (b) { this.battery = b; } };
function bytes(hex) { var b = []; for (var i = 0; i < hex.length; i += 2) b.push(parseInt(hex.substr(i, 2), 16)); return b; }
function text(s) { var b = []; for (var i = 0; i < s.length; i++) b.push(s.charCodeAt(i)); return b; }
function send(payload) { parseUplink(device, { port: null, asBytes: function () { return payload; } }); }
function assert(c, m) { if (!c) { console.error('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); }

eval(src);
var imei = process.argv[4];
getEndpoints(imei, endpoints);
assert(eps['1'] && eps['2'], 'generic distance + temperature endpoints exist');
var r = { ok: true }; validateDeviceAddress(imei, r); assert(r.ok, 'IMEI accepted');
r = { ok: true }; validateDeviceAddress('000000000000000', r); assert(!r.ok, 'unknown IMEI rejected');
r = { ok: true }; validateDeviceAddress('244E7B0000004656', r); assert(!r.ok, 'a DevEUI is rejected by the TCP model');

// TEK 811 manual sample (9-5987-03): scheduled reading, ullage 119 cm, SRC 10, SRSSI 10, 19.5 C, battery (30 + 20) / 10 V.
var sample = '072102018B06340866425030672135047B00018D03DC3C8201000A632877';
send(bytes(sample));
assert(device.battery && device.battery.voltage === 5, 'TEK 811: battery 5 V');
assert(eps['2'].value === 19.5, 'TEK 811: temperature 19.5 C');
assert(eps['1'].value === 1190, 'TEK 811: distance 1190 mm');
send(text(sample));
assert(eps['1'].value === 1190 && /ullage 119 cm/.test(logs[logs.length - 1]), 'TEK 811 as hex text decodes the same');
send(bytes(sample.slice(0, 30) + '0A' + sample.slice(32)));
assert(/settings, diagnostics or GPS/.test(logs[logs.length - 1]), 'TEK 811 settings message logged, no reading');
// A frame of the newer Tekelek cellular layout, as a sensor sent it (product byte 0x22): IMEI in bytes 9-16,
// first reading at byte 46 = ullage 544 mm, SRC 10, SRSSI 10, 25 C, CRC-16/XMODEM in the last two bytes.
var cell = '2205270800000544600868206088952001005800002000091900007fb50005121326004604500106000000000000' +
  '001019aa0220001019aa023a001019a8023d000119a802c4' + new Array(37).join('00') + 'c683';
send(bytes(cell));
assert(eps['1'].value === 544 && eps['2'].value === 25, 'Tekelek cellular frame: distance 544 mm, temperature 25 C');
assert(/Tekelek sensor 0x22, ullage 544 mm, SRC 10, SRSSI 10, temperature 25 C, distance 544 mm, level /.test(logs[logs.length - 1]), 'Tekelek cellular frame: logged with its level');
send(text(cell.toUpperCase()));
assert(eps['1'].value === 544 && !/checksum/.test(logs[logs.length - 1]), 'Tekelek cellular frame as hex text decodes the same, checksum matches');
send(text(JSON.stringify({ imei: imei, distance: 1500, battery: 3.6, temperature: 21 })));
assert(eps['1'].value === 1500 && eps['2'].value === 21, 'JSON text: distance and temperature');
send(bytes('12')); send([]);
assert(/Unknown message type/.test(logs[logs.length - 2]) && /Empty payload/.test(logs[logs.length - 1]), 'unknown + empty handled');
logs.forEach(function (l) { console.log('  ' + l); });
