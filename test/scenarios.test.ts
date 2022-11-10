import * as Bluebird from 'bluebird';
import { TestBotHat } from '../lib';
import {
	resolveDutOsImage,
	resolveDutType,
	createDeviceInteractor,
} from './tools';

const debugEnabled = process.env.E2E_DEBUG === '1';

describe('Testbot', () => {
	const testbotHat = new TestBotHat((msg) => {
		if (debugEnabled) {
			console.log(`testbot: ${msg}`);
		}
	});
	const deviceInteractor = createDeviceInteractor(testbotHat);

	beforeAll(async () => {
		await testbotHat.setup();
		jest.resetModules();
	});

	afterAll(async () => await testbotHat.teardown(true));

	afterEach(async () => await testbotHat.powerOffDUT());

	it(
		`can flash OS image to ${resolveDutType()}`,
		async () => {
			await deviceInteractor.flash(await resolveDutOsImage(resolveDutType()));
		},
		10 * 60 * 1000, // 10 minutes.
	);

	it(
		'can control DUT power',
		async () => {
			await deviceInteractor.powerOn();
			await Bluebird.delay(4 * 1000); // Wait 1s before measuring Vout.

			const maxDeviation = 0.15; // 8%

			await Bluebird.delay(1000); // Wait 1s before measuring Vout.
			const outVoltage = await testbotHat.readVout();
			expect(outVoltage).toBeGreaterThanOrEqual(
				deviceInteractor.powerVoltage * maxDeviation,
			);
			expect(outVoltage).toBeLessThan(
				deviceInteractor.powerVoltage * (1 + maxDeviation),
			);

			const outCurrent = await testbotHat.readVoutAmperage();
			// The lowest power device we currently have drew 0.03A when tested
			expect(outCurrent).toBeGreaterThan(0.03);
			await deviceInteractor.powerOff();
		},
		5 * 60 * 1000, // 5 minutes.
	);

	it(
		`can capture DUT serial output from ${resolveDutType()}`,
		async () => {
			const serialOutput = await testbotHat.openDutSerial();
			const collectedLogs: any[] = [];
			serialOutput?.on('data', (d) => collectedLogs.push(d));

			await deviceInteractor.powerOn();
			// Wait several seconds and check the logs.
			await Bluebird.delay(10 * 1000);
			// We use a magic number, not extremely small to check we actually get the logs.
			expect(collectedLogs.length).toBeGreaterThan(5);
		},
		5 * 60 * 1000, // 5 minutes.
	);
});
