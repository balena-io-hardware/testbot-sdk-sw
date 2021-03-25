# testbotSDK

> The SDK is for internal use only.

The testbot is a device used to aid in the automation of hardware testing. It provides a mechanism to remotely provision, power, and run test suites against a device under test (DUT).

## Introduction

This document aims to describe all operations, & examples supported by the Testbot SDK. Get started by installing the NPM package and following the **Getting Started** guide below. You can use the testbot SDK to flash, control, turn your Device Under Test (DUT) ON and OFF and even record serial output when testing remotely.

If you feel something is missing, not clear or could be improved, please open an [issue on GitHub](https://github.com/balena-io/testbotsdk/issues/new).


## Installation

Install the [testbotSDK](https://www.npmjs.com/package/@balena/testbot) NPM package.

```bash
npm install @balena/testbot --save
```

## Getting Started

After assembling your testbot, the testbot SDK can be used to perform operations on the DUT.

### Prerequistes: Import and Instantiating

Import the required classes, and instantiate objects to refer to them later. To perform operations on the Device Under Test (DUT), testbot needs to learn how to interact with your specifc test device.

For that you need to create a [DeviceInteractor](./classes/_devices_.deviceinteractor.html) class. Follow the [example](https://github.com/balena-io/testbotsdk/blob/master/lib/devices.ts) in the documentation to create your own interactor class for your Device Under Test (DUT).

```ts
import { TestBotHat } from '@balena/testbot';
import { SomeNewDevice } from './devices';

const testbotHat = new TestBotHat()
const deviceInteractor = SomeNewDevice(testbotHat);
```

We already provide full support for `RaspberryPi` and `Intel-NUC` classes that can be used as reference. For the getting started guide, we will be using the device called `SomeNewDevice`, which has a class named `SomeNewDevice`.

### Flashing the DUT

To flash the DUT, use the method `flashFromeFile()` method included in the base `DeviceInteractor` class.

```ts
import { TestBotHat } from '@balena/testbot';
import { SomeNewDevice } from './devices';

const testbotHat = new TestBotHat()
const deviceInteractor = SomeNewDevice(testbotHat);

deviceInteractor.flashFromFile("./images/balenaOS.img.gz");
```

### Powering ON/OFF the DUT

To power cycle the DUT, use the `powerOn()` and `powerOff()` methods we created in our [`SomeNewDevice`](https://github.com/balena-io/testbotsdk/blob/master/lib/devices.ts) interactor class.

```ts
import { TestBotHat } from '@balena/testbot';
import { SomeNewDevice } from './devices';

const testbotHat = new TestBotHat()
const deviceInteractor = SomeNewDevice(testbotHat);

await deviceInteractor.powerOn();
await deviceInteractor.powerOff();
```

### Collecting Serial Output from DUT

```ts
import { TestBotHat } from '@balena/testbot';
const testbotHat = new TestBotHat()

const serialOutput = await testbotHat.openDutSerial();
const collectedLogs: any[] = [];
serialOutput?.on('data', (d) => collectedLogs.push(d));

await deviceInteractor.powerOn();
// Wait several seconds and check the logs. We are using Bluebird to wait.
import * as Bluebird from 'bluebird';
await Bluebird.delay(10000);
console.log(collectedLogs)
```

For a complete reference, you can check out how we implment testbot SDK to test the testbot hardware itself as part of our e2e tests deployed on `testbot-e2e-test` application - https://github.com/balena-io/testbotsdk/tree/master/test


## Generating documentation for testbotSDK

TestbotSDK documentation is written on the [tsdoc doc comment](https://github.com/microsoft/tsdoc) standard and generated using [Typedoc](https://typedoc.org/). The documentation for the SDK can be generated using the command below. The generated documentation can be viewed on `docs/index.html`

```bash
npm run docs
```
