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
			await deviceInteractor.flashFromFile(
				await resolveDutOsImage(resolveDutType()),
			);
		},
		10 * 60 * 1000, // 10 minutes.
	);

	it(
		'can control DUT power',
		async () => {
			await deviceInteractor.powerOn();
			await Bluebird.delay(999000); // Wait 1s before measuring Vout.
			await deviceInteractor.powerOff();
		},
		5 * 60 * 1000, // 5 minutes.
	);
});
