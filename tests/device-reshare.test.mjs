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

test('a device that is shared again keeps receiving updates from Homey', { timeout: 30000 }, async (t) => {
  const instances = [];
  const device = {
    id: 'socket', name: 'socket', class: 'socket', ready: true,
    capabilitiesObj: { onoff: { value: false } },
    getDriver: async () => { return { name: 'Test device', ownerName: 'Test app' }; },
    makeCapabilityInstance: (capabilityId, listener) => {
      const instance = { capabilityId, listener, destroyed: false, destroy: () => { instance.destroyed = true; } };
      instances.push(instance);
      return instance;
    },
    setCapabilityValue: async () => {},
  };

  const devices = new EventEmitter();
  devices.connect = async () => {};
  devices.getDevices = async () => { return { [device.id]: device }; };
  devices.getDevice = async ({ id }) => { return id === device.id ? device : null; };
  const directory = await mkdtemp(join(tmpdir(), 'matter-device-toggle-'));
  const bridge = new MatterBridgeServer({
    api: { devices, drivers: { connect: async () => {}, getDrivers: async () => { return {}; } } },
    debug: () => {},
    deviceName: 'Test bridge', vendorName: 'Test', vendorId: 65521,
    productName: 'Test bridge', productId: 32768, uniqueId: 'device-toggle-test', serialNumber: 'test',
    passcode: 20202021, discriminator: 1710, port: 0,
    storageServiceLocation: directory,
    enabledDeviceIds: new Set([device.id]),
  });
  t.after(async () => {
    await bridge.stop();
    await Environment.default.runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  await bridge.start();
  assert.equal(instances.length, 1);

  // Deselected in the settings
  await bridge.disableDevice(device.id);
  assert.equal(instances[0].destroyed, true);
  assert.equal(bridge.deviceEndpoints[device.id], undefined);
  assert.equal(bridge.deviceCapabilityInstances[device.id], undefined);

  // Selected again
  await bridge.enableDevice(device.id);
  assert.equal(instances.length, 2);
  assert.equal(instances[1].destroyed, false);

  // A change in Homey reaches the new endpoint
  const [endpoint] = bridge.deviceEndpointInstances[device.id];
  instances[1].listener(true);
  for (let i = 0; i < 50 && endpoint.state.onOff.onOff !== true; i++) await sleep(20);
  assert.equal(endpoint.state.onOff.onOff, true);
});
