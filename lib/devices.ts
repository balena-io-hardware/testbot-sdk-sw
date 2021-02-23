import * as Bluebird from 'bluebird';
import { fs } from 'mz';
import * as Stream from 'stream';
import * as zlib from 'zlib';
import { TestBot } from './base';

/**
 * `DeviceInteractor` class can be used as a base class for interaction with a
 * particular DUT type through the testbot. Extend this class and use its methods
 * to form implementation of other new `deviceType`.
 *
 * @example
 * Use this example snippet below to get started on creating a new deviceType
 * implmentation. Our new device is called SomeNewDevice.
 * ```ts
 * export class SomeNewDevice extends DeviceInteractor {
 * 		// 7 volts is our sample target voltage needed to power ON the SomeNewDevice.
 * 		constructor(testBot: TestBot) {
 * 			super(testBot, 7);
 * 	 	}
 *
 *   	async powerOn() {
 * 			// Instructions to power on DUT go here, steps broadly are:
 * 			// 1. Set the target voltage with setVout(this.powerVoltage)
 * 			// 2. Switch SD card to the DUT with switchSdToDUT()
 * 			// 3. Power on the DUT with powerOnDUT()
 * 			// 4. Any custom steps
 *   	}
 *
 * 	 	private customDeviceSpecificMethod() {
 * 	 		// Code goes here!
 * 	 	}
 * }
 * ```
 *
 * @remark
 * You can check {@link https://github.com/balena-io/testbotsdk/blob/master/lib/devices.ts}
 * for device implementation of RaspberryPi and Intel-nuc `deviceType` as examples.
 */
export abstract class DeviceInteractor {
	/**
	 * @param powerVoltage The value of target voltage in volts needed by the DUT. This
	 * value is used to set the output voltage that is supplied to the DUT.
	 */
	protected constructor(
		protected readonly testBot: TestBot,
		public readonly powerVoltage: number,
	) {}

	/**
	 * Flash the SD card inside the SD Mux.
	 *
	 * @param stream Pass stream of the image file to be flashed
	 */
	async flash(stream: Stream.Readable) {
		await this.testBot.flash(stream);
	}

	/**
	 * Specify filepath of image to flash and creates a stream of the image. Image
	 * file should be compressed with gzip compressions (having file extension `.gz`).
	 *
	 * @param filePath file path of the image.
	 * @throws Will result in error if the filepath end with `.zip`. Zip files are not supported.
	 */
	async flashFromFile(filePath: string) {
		if (filePath.endsWith('.zip')) {
			throw new Error('zip files are not supported');
		}

		let src: Stream.Readable = await fs.createReadStream(filePath);
		if (filePath.endsWith('.gz')) {
			src = src.pipe(zlib.createGunzip());
		}
		await this.flash(src);
	}

	/** Signals the DUT to be powered off and close the DUT serial output stream. */
	async powerOff() {
		await this.testBot.closeDutSerial();
		await this.testBot.powerOffDUT();
	}

	/**
	 * Abstract method to power ON the DUT as per specifications.
	 *
	 * @remark
	 * Use this method to define a set of instructions for powering on the DUT, since
	 * each device has a widely different power on procedure and different voltage
	 * needed hence the method is kept abstract.
	 */
	abstract async powerOn(): Promise<void>;
}

/** Implementation for Raspberry Pi like devices. */
export class RaspberryPi extends DeviceInteractor {
	constructor(testBot: TestBot) {
		super(testBot, 5);
	}

	async powerOn() {
		await this.testBot.setVout(this.powerVoltage);
		await this.testBot.switchSdToDUT(1000);
		await this.testBot.powerOnDUT();
	}
}

/** Implementation for Intel NUC devices. */
export class IntelNuc extends DeviceInteractor {
	constructor(testBot: TestBot) {
		super(testBot, 12);
	}

	async powerOn() {
		await this.testBot.setVout(this.powerVoltage);
		await this.testBot.switchSdToDUT(1000);
		await this.testBot.powerOnDUT();

		await Bluebird.delay(5000); // Wait 5s before measuring current for the first time, or we may power off again during flashing!
		let current = await this.testBot.readVoutAmperage();
		console.log('Initial current measurement:' + current + ' Amps');
		while (current > 0.1) {
			await Bluebird.delay(5000); // Wait 5s before measuring current again.
			current = await this.testBot.readVoutAmperage();
			console.log(
				'Awaiting DUT to flash and power down, current: ' + current + ' Amps',
			);
		}
		console.log('Internally flashed - powering off DUT');
		// Once current has dropped below the threshold, power off and toggle mux.
		await this.testBot.powerOffDUT();
		await this.testBot.switchSdToHost(1000);
		// Turn power back on, this should now get the NUC to boot from internal mmc as USB is no longer connected.
		await this.testBot.powerOnDUT();
		console.log('Powering on DUT - should now boot from internal storage');
	}
}
