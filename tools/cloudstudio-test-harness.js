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
function send(hex, port) { parseUplink(device, { port: port || 1, asBytes: function () { return bytes(hex); } }); }
function assert(c, m) { if (!c) { console.error('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); }

eval(src);
var devEui = process.argv[4];
getEndpoints(devEui, endpoints);
assert(eps['1'] && eps['2'], 'generic distance + temperature endpoints exist');
var r = { ok: true }; validateDeviceAddress(devEui, r); assert(r.ok, 'DevEUI accepted');
r = { ok: true }; validateDeviceAddress('0000000000000000', r); assert(!r.ok, 'unknown DevEUI rejected');

send('300000010106360063006300040600181BAA');
assert(device.battery && device.battery.percentage === 99, 'status: battery 99 %');
assert(eps['2'].value === 27, 'status: temperature 27 C');
send('1000000001121B7701131BAA01121BA90114F274');
assert(/INVALID/.test(logs[logs.length - 1]), 'measurement with SRC 7 is rejected');
send('45000100001E17AA001E16A9');
assert(/ALARM limit 1/.test(logs[logs.length - 1]), 'alarm frame parsed');
send('12'); send('');
assert(/Unknown message type/.test(logs[logs.length - 2]) && /Empty payload/.test(logs[logs.length - 1]), 'unknown + empty handled');
logs.forEach(function (l) { console.log('  ' + l); });
