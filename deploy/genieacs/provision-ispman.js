// GenieACS provision "ispman", run at every check-in of every device.
//
// Asks ISPMan what this ONU should have (ext/ispman.js) and declares it:
// Wi-Fi name and password on the Wi-Fi networks that are switched on, and the
// PPPoE login where the ONU has a PPPoE connection. Both data models: TR-098
// (InternetGatewayDevice, most ONUs) and TR-181 (Device).
//
// SENT ONCE PER VERSION. ISPMan's answer carries a version that changes only
// when the values do. The device is tagged "ispman-<version>" once they are
// sent, and nothing is sent again for that version — many ONUs never read
// their Wi-Fi password back, and without this it would be rewritten, and the
// Wi-Fi restarted, at every check-in.
//
// Also asks every ONU to check in every 5 minutes, so a change made in
// ISPMan reaches it soon even when the ACS cannot reach it directly.

const now = Date.now();
const serial = declare("DeviceID.SerialNumber", {value: 1}).value[0];
const id = declare("DeviceID.ID", {value: 1}).value[0];

let root = "InternetGatewayDevice";
let model = declare("InternetGatewayDevice.DeviceInfo.ModelName", {value: 1});
if (!model.size) {
  root = "Device";
  model = declare("Device.DeviceInfo.ModelName", {value: 1});
}
const modelName = model.size ? model.value[0] : "";

declare(root + ".ManagementServer.PeriodicInformEnable", {value: 1}, {value: true});
declare(root + ".ManagementServer.PeriodicInformInterval", {value: 1}, {value: 300});

const cfg = ext("ispman", "config", serial, modelName, id);

if (cfg && cfg.ok && cfg.set && cfg.version) {
  const tag = "Tags.ispman-" + cfg.version;
  const already = declare(tag, {value: 1});
  if (!already.size) {
    if (root === "InternetGatewayDevice") {
      // Only the Wi-Fi networks that are switched on: guest and spare SSIDs stay as they are.
      const wlans = declare("InternetGatewayDevice.LANDevice.*.WLANConfiguration.*.Enable", {value: now});
      for (const w of wlans) {
        if (w.value[0] !== true) continue;
        const base = w.path.slice(0, -".Enable".length);
        if (cfg.ssid) declare(base + ".SSID", {value: 1}, {value: cfg.ssid});
        if (cfg.pass) {
          declare(base + ".PreSharedKey.1.KeyPassphrase", {value: 1}, {value: cfg.pass});
          declare(base + ".KeyPassphrase", {value: 1}, {value: cfg.pass});
        }
      }
      if (cfg.pppoeUser && cfg.pppoePass) {
        declare("InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.Username", {value: 1}, {value: cfg.pppoeUser});
        declare("InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.Password", {value: 1}, {value: cfg.pppoePass});
      }
    } else {
      const ssids = declare("Device.WiFi.SSID.*.Enable", {value: now});
      for (const s of ssids) {
        if (s.value[0] !== true) continue;
        const base = s.path.slice(0, -".Enable".length);
        if (cfg.ssid) declare(base + ".SSID", {value: 1}, {value: cfg.ssid});
      }
      if (cfg.pass) declare("Device.WiFi.AccessPoint.*.Security.KeyPassphrase", {value: 1}, {value: cfg.pass});
      if (cfg.pppoeUser && cfg.pppoePass) {
        declare("Device.PPP.Interface.*.Username", {value: 1}, {value: cfg.pppoeUser});
        declare("Device.PPP.Interface.*.Password", {value: 1}, {value: cfg.pppoePass});
      }
    }
    // The previous version's tag goes; this one's marks it sent.
    const tags = declare("Tags.*", {value: 1});
    for (const t of tags) {
      if (t.path.indexOf("Tags.ispman-") === 0 && t.path !== tag) declare(t.path, null, {value: false});
    }
    declare(tag, null, {value: true});
  }
}
