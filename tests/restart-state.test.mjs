import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { Environment, Logger } from '@matter/main';
import MatterBridgeServer from '../lib/MatterBridgeServer.mjs';

Logger.level = 'error';

async function startBridge(light, storageServiceLocation) {
  const devices = new EventEmitter();
  devices.connect = async () => {};
  devices.getDevices = async () => { return { [light.id]: light }; };
  const errors = [];
  const bridge = new MatterBridgeServer({
    api: { devices, drivers: { connect: async () => {}, getDrivers: async () => { return {}; } } },
    debug: (message) => { if (String(message).startsWith('Error')) errors.push(message); },
    deviceName: 'Test bridge', vendorName: 'Test', vendorId: 65521,
    productName: 'Test bridge', productId: 32768, uniqueId: 'restart-state-test', serialNumber: 'test',
    passcode: 20202021, discriminator: 1721, port: 0,
    storageServiceLocation,
    enabledDeviceIds: new Set([light.id]),
  });
  await bridge.start();
  const [endpoint] = bridge.deviceEndpointInstances[light.id];
  return { bridge, endpoint, bridgedNode: bridge.deviceEndpoints[light.id], errors };
}

test('a device that changed while the bridge was stopped reports its current state', { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'matter-restart-state-'));
  t.after(async () => {
    await Environment.default.runtime.close();
    await rm(directory, { recursive: true, force: true });
  });

  const listeners = {};
  const light = {
    id: '66666666-6666-4666-8666-666666666666', name: 'Light', class: 'light', ready: true,
    capabilitiesObj: { onoff: { value: true }, dim: { value: 0.8 } },
    getDriver: async () => { return { name: 'Test device', ownerName: 'Test app' }; },
    makeCapabilityInstance: (capabilityId, listener) => {
      listeners[capabilityId] = listener;
      return { destroy: () => {} };
    },
    setCapabilityValue: async () => {},
  };

  // While running, the light is turned off and dimmed in Homey
  const first = await startBridge(light, directory);
  listeners.onoff(false);
  listeners.dim(0.2);
  await sleep(100);
  assert.equal(first.endpoint.state.onOff.onOff, false);
  await first.bridge.stop();

  // While the bridge is stopped, the light is turned on at 80% and renamed in Homey
  light.capabilitiesObj.onoff.value = true;
  light.capabilitiesObj.dim.value = 0.8;
  light.name = 'Renamed light';

  const second = await startBridge(light, directory);
  try {
    assert.deepEqual(second.errors, []);
    assert.equal(second.endpoint.state.onOff.onOff, true);
    assert.ok(Math.abs(second.endpoint.state.levelControl.currentLevel - (1 + 0.8 * 253)) < 0.01);
    assert.equal(second.bridgedNode.state.bridgedDeviceBasicInformation.nodeLabel, 'Renamed light');
  } finally {
    await second.bridge.stop();
  }
});
