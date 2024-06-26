import * as Bluebird from 'bluebird';
import { TestBot } from './base';
import * as sdk from 'etcher-sdk';
import { BlockDeviceAdapter } from 'etcher-sdk/build/scanner/adapters';
import { exec } from 'mz/child_process';

const POLL_INTERVAL = 1000; // 1 second
const POLL_TRIES = 20; // 20 tries
const HIGH = 1;
const LOW = 0;

// import * as retry from 'bluebird-retry';

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
	async flash(filePath: string) {
		await this.testBot.flash(filePath);
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

		await this.flash(filePath);
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
	abstract powerOn(): Promise<void>;
}

/**
 * `DeviceInteractorFlasher` class can be used as a base class for interaction with a
 * flasher DUT type (a DUT which boots the balenaOS flasher image from a removable media,
 * either SD card or USB thumb drive, and waits for this flasher image to finish installing
 * balenaOS onto the internal DUT storage).
 *
 *
 */
export abstract class FlasherDeviceInteractor extends DeviceInteractor {
	/** All flasher DUTs should use the same power-on procedure */
	async powerOn() {
		await this.testBot.setVout(this.powerVoltage);
		await this.testBot.switchSdToHost(1000);
		await this.testBot.powerOnDUT();
	}

	/**
	 * Flash the external media (SD card, USB thumb drive) with the balenaOS flasher then
	 * let it boot and wait for the DUT to be flashed with balenaOS.
	 *
	 * @param stream The stream of the flasher image file to be flashed onto the external installer media
	 */
	async flash(filePath: string) {
		// first flash the external media
		await this.testBot.flash(filePath);
		// wait for the DUT to self-shutdown after balenaOS flasher finishes provisiong the internal media
		await this.waitInternalFlash();
		// after the DUT has been provisioned with balenaOS, detach the external media from the DUT
		await this.testBot.switchSdToHost(1000);
	}

	async checkDutPower() {
		const [stdout, stderr] = await exec(`cat /sys/class/net/eth1/carrier`);
		console.log(stderr);
		const file = stdout.toString();
		if (file.includes('1')) {
			console.log(`DUT is currently On`);
			return true;
		} else {
			console.log(`DUT is currently Off`);
			return false;
		}
	}

	/** Power on the DUT and wait for balenaOS to be provisioned onto internal media */
	async waitInternalFlash() {
		await this.testBot.powerOffDUT();
		await this.testBot.switchSdToDUT(1000); // Wait for 1s after toggling mux, to ensure that the mux is toggled to DUT before powering it on
		await this.testBot.setVout(this.powerVoltage);

		// Add a slight delay here to ensure that the DUT does not power on before the MUX is actually toggled to the DUT.
		await Bluebird.delay(1000 * 5);

		console.log('Booting DUT with the balenaOS flasher image');
		await this.testBot.powerOnDUT();

		// check if the DUT is on first
		let dutOn = false;
		while (!dutOn) {
			console.log(`waiting for DUT to be on`);
			dutOn = await this.checkDutPower();
			await Bluebird.delay(1000 * 5); // 5 seconds between checks
		}
		// once we confirmed the DUT is on, we wait for it to power down again, which signals the flashing has finished
		// wait initially for 60s and then every 10s before checking if the board performed a shutdown after flashing the internal storage
		await Bluebird.delay(1000 * 60);
		while (dutOn) {
			await Bluebird.delay(1000 * 10); // 10 seconds between checks
			console.log(`waiting for DUT to be off`);
			dutOn = await this.checkDutPower();
			// occasionally the DUT might appear to be powered down, but it isn't - we want to confirm that the DUT has stayed off for an interval of time
			if (!dutOn) {
				let offCount = 0;
				console.log(`detected DUT has powered off - confirming...`);
				for (let tries = 0; tries < POLL_TRIES; tries++) {
					await Bluebird.delay(POLL_INTERVAL);
					dutOn = await this.checkDutPower();
					if (!dutOn) {
						offCount += 1;
					}
				}
				console.log(
					`DUT stayted off for ${offCount} checks, expected: ${POLL_TRIES}`,
				);
				if (offCount !== POLL_TRIES) {
					// if the DUT didn't stay off, then we must try the loop again
					dutOn = true;
				}
			}
		}

		if (dutOn) {
			throw new Error('Timed out while waiting for DUT to flash');
		} else {
			console.log('Internally flashed - powering off DUT');
			// power off and toggle mux.
			await this.testBot.powerOffDUT();
			await this.testBot.switchSdToHost(1000);
		}
	}
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

/** Implementation for RT Rpi3 300 like devices. */
export class RtRpi300 extends DeviceInteractor {
	constructor(testBot: TestBot) {
		super(testBot, 12);
	}

	async powerOn() {
		await this.testBot.setVout(this.powerVoltage);
		await this.testBot.switchSdToDUT(1000);
		await this.testBot.powerOnDUT();
	}
}

/** Implementation for RPI3Neuron like devices. */
export class RPI3Neuron extends DeviceInteractor {
	constructor(testBot: TestBot) {
		super(testBot, 24);
	}

	async powerOn() {
		await this.testBot.setVout(this.powerVoltage);
		await this.testBot.switchSdToDUT(1000);
		await this.testBot.powerOnDUT();
	}
}

/** Implementation for RPI4Neuron like devices. */
export class RPI4Neuron extends DeviceInteractor {
	constructor(testBot: TestBot) {
		super(testBot, 24);
	}

	async powerOn() {
		await this.testBot.setVout(this.powerVoltage);
		await this.testBot.switchSdToDUT(1000);
		await this.testBot.powerOnDUT();
	}
}

/** Implementation for Jetson Nano SD-CARD device. */
export class JetsonNano extends DeviceInteractor {
	constructor(testBot: TestBot) {
		super(testBot, 5);
	}

	async powerOn() {
		await this.testBot.setVout(this.powerVoltage);
		await this.testBot.switchSdToDUT(1000);
		await Bluebird.delay(1000 * 5);
		await this.testBot.powerOnDUT();
	}
}

/** Implementation for CM4 IO-Board */
export class CM4IOBoard extends DeviceInteractor {
	constructor(testBot: TestBot) {
		super(testBot, 12);
	}

	async powerOn() {
		await this.testBot.setVout(this.powerVoltage);
		await this.testBot.switchSdToDUT(1000);
		await this.testBot.powerOnDUT();
	}
}

/** Implementation for RockPro64 */
export class RockPro64 extends DeviceInteractor {
	constructor(testBot: TestBot) {
		super(testBot, 12);
	}

	async powerOn() {
		await this.testBot.setVout(this.powerVoltage);
		await this.testBot.switchSdToDUT(1000);
		await this.testBot.powerOnDUT();
	}
}

/** Implementation for Beaglebone like devices. */
export class BeagleBone extends FlasherDeviceInteractor {
	constructor(testBot: TestBot) {
		super(testBot, 5);
	}
}

/** Implementation for IMX8MM EBCRS A2 */
export class Imx8mmebcrs08a2 extends FlasherDeviceInteractor {
	constructor(testBot: TestBot) {
		super(testBot, 12);
	}
}

/** Implementation for Rockpi 4B RK3399 */
export class Rockpi4bRk3399 extends FlasherDeviceInteractor {
	constructor(testBot: TestBot) {
		super(testBot, 12);
	}
}

/** Implementation for the Coral Dev Board */
export class CoralDevBoard extends FlasherDeviceInteractor {
	constructor(testBot: TestBot) {
		super(testBot, 5);
	}
}

/** Implementation for the iMX8MM-VAR-DART-NRT Board */
export class Imx8mmVarDartNRT extends FlasherDeviceInteractor {
	constructor(testBot: TestBot) {
		super(testBot, 5);
	}

	async checkDutPower() {
		const outCurrent = await this.testBot.readVoutAmperage();
		console.log(`Out current is: ` + outCurrent);
		// Add upper bound as sometimes current sensor report ~80A when DUT is powering off
		if (outCurrent > 0.03 && outCurrent < 50) {
			console.log(`Imx8mmVarDartNRT is currently On`);
			return true;
		} else {
			console.log(`Imx8mmVarDartNRT is currently Off`);
			return false;
		}
	}
}

/**
 * Implementation for Jetson TX2
 * We turn the TX2 on and off using GPIO26 on the testbot HAT, which is
 * connected to a 5V relay. GPIO13 is connected to J21.1 (3v3) on
 * the TX2 to determine the DUT power state.
 */
export class JetsonTX2 extends FlasherDeviceInteractor {
	constructor(testBot: TestBot) {
		super(testBot, 5);
	}
	private gpiosEnabled: boolean = false;
	PINS = {
		DUT_PW_EN: 14,
		OE_TXB: 13,
		OE_TXS: 15,
	};

	async enableGPIOs() {
		if (this.gpiosEnabled) {
			return;
		}
		await this.testBot.digitalWrite(this.PINS.OE_TXB, HIGH);
		await this.testBot.digitalWrite(this.PINS.OE_TXS, HIGH);
		await Bluebird.delay(100);

		/* Toggles the power relay */
		await exec(`echo 26 > /sys/class/gpio/export || true`).catch(() => {
			console.log(`Failed to export gpio for controlling TX2 power`);
		});
		await exec(
			`echo out > /sys/class/gpio/gpio26/direction && echo 1 > /sys/class/gpio/gpio26/value`,
		).catch(() => {
			console.log(`Failed to set gpio26 as output`);
		});

		/* Used for checking if the TX2 is on or off */
		await exec(`echo 13 > /sys/class/gpio/export || true`).catch(() => {
			console.log(`Failed to export gpio for checking TX2 power`);
		});
		await exec(`echo in > /sys/class/gpio/gpio13/direction`).catch(() => {
			console.log(`Failed to set gpio13 as input`);
		});
		await Bluebird.delay(100);
		this.gpiosEnabled = true;
	}

	public async checkDutPower() {
		await this.enableGPIOs();
		const [stdout, stderr] = await exec(`cat /sys/class/gpio/gpio13/value`);
		console.log(stderr);
		const file = stdout.toString();

		if (file.includes('1')) {
			console.log(`checkDutPower() - DUT is currently On`);
			return true;
		} else {
			console.log(`checkDutPower() - DUT is currently Off`);
			return false;
		}
	}

	async checkDutBooted() {
		const [stdout, stderr] = await exec(`cat /sys/class/net/eth1/carrier`);
		console.log(stderr);
		const file = stdout.toString();
		if (file.includes('1')) {
			return true;
		} else {
			return false;
		}
	}

	async powerOff() {
		console.log(`powerOff - Will turn off TX2`);
		const dutIsOn = await this.checkDutPower();
		if (dutIsOn) {
			console.log('TX2 is booted, trigger normal shutdown');
			/* Simulate short press on the power button */
			await this.powerOffDUT();
		} else {
			console.log('TX2 is not booted, no power toggle needed');
		}
	}
	async powerOnDUT() {
		await this.enableGPIOs();
		await this.powerOnRelay();
		await Bluebird.delay(1000);
		await exec(`echo 0 > /sys/class/gpio/gpio26/value`);
		await Bluebird.delay(3000);
		await exec(`echo 1 > /sys/class/gpio/gpio26/value`);
		await Bluebird.delay(3000);
		console.log(`Triggered power on sequence on TX2`);
	}

	/* NOTE: The 5V relay does not seem to work reliably if powered from the HAT
	 * so we use an external source for now.
	 */
	async powerOnRelay() {
		await this.testBot.setVout(this.powerVoltage);
		await this.testBot.digitalWrite(this.PINS.DUT_PW_EN, HIGH);
	}

	async powerOffRelay() {
		await this.testBot.digitalWrite(this.PINS.DUT_PW_EN, LOW);
	}

	async powerOffDUT() {
		await this.enableGPIOs();
		await this.powerOnRelay();
		await Bluebird.delay(1000);
		/* Forcedly power off device, even if it is on */
		await exec(`echo 0 > /sys/class/gpio/gpio26/value`);
		await Bluebird.delay(10 * 1000);
		await exec(`echo 1 > /sys/class/gpio/gpio26/value`);

		console.log(`Triggered power off sequence on TX2`);
		await Bluebird.delay(1000);

		/* Ensure device is off */
		const dutIsOn = await this.checkDutPower();
		if (dutIsOn) {
			console.log('WARN: Triggered force shutdown but TX2 did not power off');
		}
		await this.powerOffRelay();
	}

	async powerOn() {
		await this.testBot.switchSdToHost(1000);
		await this.powerOnDUT();
	}

	/* Power on the DUT and wait for balenaOS to be provisioned onto internal media */
	async waitInternalFlash() {
		console.log(`Ensure TX2 is powered off`);
		await this.powerOff();
		let retries = 10;
		let dutIsOn = await this.checkDutPower();

		/* Leave some time for the TX2 to gracefully shut down in case it was on for any reason */
		while (dutIsOn && --retries) {
			await Bluebird.delay(1000 * 10); // 10 seconds between checks
			console.log(
				`Waiting for TX2 to be off - Will check again at most ${retries} times`,
			);
			dutIsOn = await this.checkDutPower();
			if (10 === retries) {
				throw new Error('Failed to power off the TX2 before flashing');
			}
		}

		await this.testBot.switchSdToDUT(1000); // Wait for 1s after toggling mux, to ensure that the mux is toggled to DUT before powering it on
		console.log('Booting TX2 with the balenaOS flasher image');
		await this.powerOnDUT();

		// check if the DUT is on first
		let dutOn = false;
		let dutBooted = false;

		while (!dutOn) {
			console.log(`Waiting for TX2 to be on`);
			dutOn = await this.checkDutPower();
			await Bluebird.delay(1000 * 5); // 5 seconds between checks
		}
		// once we confirmed the DUT is on, we wait for it to power down again, which signals the flashing has finished
		// wait initially for 60s and then every 10s before checking if the board performed a shutdown after flashing the internal storage
		await Bluebird.delay(1000 * 60);
		while (dutOn) {
			await Bluebird.delay(1000 * 10); // 10 seconds between checks
			console.log(`Waiting for TX2 to be off`);
			dutOn = await this.checkDutPower();

			/* If the ethernet is up, then we know the kernel is booted and the device is not in an inconsitent state */
			if (!dutBooted) {
				dutBooted = await this.checkDutBooted();
			} else {
				console.log(`TX2 is on and the kernel booted`);
			}
			// occasionally the DUT might appear to be powered down, but it isn't - we want to confirm that the DUT has stayed off for an interval of time
			if (!dutOn) {
				let offCount = 0;
				console.log(`detected DUT has powered off - confirming...`);
				for (let tries = 0; tries < POLL_TRIES; tries++) {
					await Bluebird.delay(POLL_INTERVAL);
					dutOn = await this.checkDutPower();
					if (!dutOn) {
						offCount += 1;
					}
				}
				console.log(
					`TX2 stayted off for ${offCount} checks, expected: ${POLL_TRIES}`,
				);
				if (offCount !== POLL_TRIES) {
					// if the DUT didn't stay off, then we must try the loop again
					dutOn = true;
				}
			}
		}

		if (dutOn) {
			await this.powerOffDUT();
			throw new Error('Timed out while waiting for TX2 to flash');
		} else {
			console.log('TX2 finished provisioning and turned off');
			return;
		}
	}
}

/** Implementation for balenaFin v1.1.x (V10+)
 * @remark
 * For the balenaFin `v1.0.0`, see the [[BalenaFinV09]] child class.
 */
export class BalenaFin extends DeviceInteractor {
	constructor(testBot: TestBot) {
		super(testBot, 12);
	}

	// usb-toggle
	async toggleUsb(state: boolean, port: number) {
		console.log(`Toggling USB ${state ? 'on' : 'off'}`);
		await exec(
			`uhubctl -r 1000 -a ${state ? 'on' : 'off'} -p ${port} -l 1-1`,
		).catch(() => {
			console.log(`Failed. Check that uhubctl is available.`);
		});
	}

	protected async powerOnFlash() {
		await this.toggleUsb(false, 4);
		await Bluebird.delay(2000); // Wait 8s before trying to turning USB back on
		await this.toggleUsb(true, 4);
	}

	async flash(filePath: string) {
		let tries = 0;
		while (tries < 3) {
			console.log(`Entering flash method for Fin, attempt ${tries + 1}`);

			await this.toggleUsb(false, 4);
			await this.testBot.powerOffDUT();
			await Bluebird.delay(1000 * 8); // Wait 5s before trying to turning USB back on

			await this.powerOnFlash();
			// etcher-sdk (power on) usboot
			const adapters: sdk.scanner.adapters.Adapter[] = [
				new BlockDeviceAdapter({
					includeSystemDrives: () => false,
					unmountOnSuccess: false,
					write: true,
					direct: true,
				}),
				new sdk.scanner.adapters.UsbbootDeviceAdapter(),
			];
			const deviceScanner = new sdk.scanner.Scanner(adapters);
			console.log('Waiting for compute module');
			// Wait for compute module to appear over usb
			const computeModule: sdk.sourceDestination.UsbbootDrive =
				await new Promise((resolve, reject) => {
					function onAttach(
						drive: sdk.scanner.adapters.AdapterSourceDestination,
					) {
						if (drive instanceof sdk.sourceDestination.UsbbootDrive) {
							deviceScanner.removeListener('attach', onAttach);
							resolve(drive);
						}
					}
					deviceScanner.on('attach', onAttach);
					deviceScanner.on('error', reject);
					deviceScanner.start();
				});
			console.log('Compute module attached');
			// wait to convert to block device.
			await new Promise<void>((resolve, reject) => {
				function onDetach(
					drive: sdk.scanner.adapters.AdapterSourceDestination,
				) {
					if (drive === computeModule) {
						deviceScanner.removeListener('detach', onDetach);
						resolve();
					}
				}
				deviceScanner.on('detach', onDetach);
				deviceScanner.on('error', reject);
			});

			// start a timeout - if the fin takes too long to appear as a block device, we must retry from the beginning

			console.log('Waiting for compute module to reattach as a block device');

			// let reAttachFail = false;
			const dest = await new Promise(
				(
					resolve: (drive: sdk.sourceDestination.BlockDevice) => void,
					reject,
				) => {
					const timeout = setTimeout(() => {
						clearTimeout(timeout);
						console.log(`DEBUG: Timed out!`);
						reject();
					}, 1000 * 60 * 5);

					function onAttach(
						drive: sdk.scanner.adapters.AdapterSourceDestination,
					) {
						if (
							drive instanceof sdk.sourceDestination.BlockDevice &&
							drive.description === 'Compute Module'
						) {
							console.log('Attached compute module.');
							clearTimeout(timeout);
							resolve(drive);
							deviceScanner.removeListener('attach', onAttach);
						}
					}
					deviceScanner.on('attach', onAttach);
					deviceScanner.on('error', reject);
				},
			).catch(() => {
				console.log(`Caught promise reject`);
				// reAttachFail = true
			});
			deviceScanner.stop();

			if (dest instanceof Object) {
				await Bluebird.delay(1000); // Wait 1s before trying to flash
				console.log('Flashing started...');
				await this.testBot.flashToDisk(dest, filePath);
				console.log('Flashed!');
				break;
			}

			console.log(`Flashing failed`);
			tries++;
		}
		await this.toggleUsb(false, 4);
		await this.testBot.powerOffDUT();
	}

	async powerOn() {
		console.log('Powering on Fin');
		await this.toggleUsb(false, 4);
		await Bluebird.delay(1000);
		await this.testBot.setVout(this.powerVoltage);
		await this.testBot.powerOnDUT();
	}
}

/** Implementation for balenaFin v1.0.0
 * @remark
 * The balenaFin `v1.0.0` (V09) has a slightly different USB boot power sequence that may
 * damage later versions (V10+) of the balenaFin.
 */
export class BalenaFinV09 extends BalenaFin {
	protected async powerOnFlash() {
		await this.toggleUsb(false, 4);
		await Bluebird.delay(1000); // Wait 1s before trying to turning USB back on
		await this.toggleUsb(true, 4);
		await this.testBot.setVout(this.powerVoltage);
		await this.testBot.powerOnDUT();
	}
}

/** Implementation for Revolution Pi Core 3
 * @remark
 * This is similar to the Balena Fin
 */
export class RevPiCore3 extends BalenaFinV09 {}

/** Implementation for Revolution Pi Connect
 * @remark
 * This is also similar to the Balena Fin
 */
export class RevPiConnect extends BalenaFinV09 {}

/** Implementation for 243390-Rpi3
 */
export class Rpi243390 extends DeviceInteractor {
	constructor(testBot: TestBot) {
		super(testBot, 5);
	}

	// usb-toggle
	async toggleUsb(state: boolean, port: number) {
		console.log(`Toggling USB ${state ? 'on' : 'off'}`);
		await exec(
			`uhubctl -r 1000 -a ${state ? 'on' : 'off'} -p ${port} -l 1-1`,
		).catch(() => {
			console.log(`Failed. Check that uhubctl is available.`);
		});
	}

	async flash(filePath: string) {
		let tries = 0;
		while (tries < 3) {
			console.log(`Entering flash method for Rpi243390, attempt ${tries + 1}`);

			await this.toggleUsb(false, 4);
			await this.testBot.powerOffDUT();
			await Bluebird.delay(1000); // Wait 1s before trying to turning USB back on
			await this.powerOnFlash();
			// etcher-sdk (power on) usboot
			const adapters: sdk.scanner.adapters.Adapter[] = [
				new BlockDeviceAdapter({
					includeSystemDrives: () => false,
					unmountOnSuccess: false,
					write: true,
					direct: true,
				}),
				new sdk.scanner.adapters.UsbbootDeviceAdapter(),
			];
			const deviceScanner = new sdk.scanner.Scanner(adapters);
			console.log('Waiting for eMMC');
			// Wait for compute module to appear over usb
			const computeModule: sdk.sourceDestination.UsbbootDrive =
				await new Promise((resolve, reject) => {
					function onAttach(
						drive: sdk.scanner.adapters.AdapterSourceDestination,
					) {
						if (drive instanceof sdk.sourceDestination.UsbbootDrive) {
							deviceScanner.removeListener('attach', onAttach);
							resolve(drive);
						}
					}
					deviceScanner.on('attach', onAttach);
					deviceScanner.on('error', reject);
					deviceScanner.start();
				});
			console.log('Compute module attached');
			// wait to convert to block device.
			await new Promise<void>((resolve, reject) => {
				function onDetach(
					drive: sdk.scanner.adapters.AdapterSourceDestination,
				) {
					if (drive === computeModule) {
						deviceScanner.removeListener('detach', onDetach);
						resolve();
					}
				}
				deviceScanner.on('detach', onDetach);
				deviceScanner.on('error', reject);
			});

			// start a timeout - if the fin takes too long to appear as a block device, we must retry from the beginning

			console.log('Waiting for eMMC to reattach as a block device');

			// let reAttachFail = false;
			const dest = await new Promise(
				(
					resolve: (drive: sdk.sourceDestination.BlockDevice) => void,
					reject,
				) => {
					const timeout = setTimeout(() => {
						clearTimeout(timeout);
						console.log(`DEBUG: Timed out!`);
						reject();
					}, 1000 * 60 * 5);

					function onAttach(
						drive: sdk.scanner.adapters.AdapterSourceDestination,
					) {
						if (
							drive instanceof sdk.sourceDestination.BlockDevice &&
							drive.description === 'Compute Module'
						) {
							console.log('Attached compute module.');
							clearTimeout(timeout);
							resolve(drive);
							deviceScanner.removeListener('attach', onAttach);
						} else {
							console.log('Drive is ' + drive.description);
						}
					}
					deviceScanner.on('attach', onAttach);
					deviceScanner.on('error', reject);
				},
			).catch(() => {
				console.log(`Caught promise reject`);
				// reAttachFail = true
			});
			deviceScanner.stop();

			if (dest instanceof Object) {
				await Bluebird.delay(5000); // Wait 1s before trying to flash
				console.log('Flashing started...');
				await this.testBot.flashToDisk(dest, filePath);
				console.log('Flashed!');
				break;
			}

			console.log(`Flashing failed`);
			tries++;
		}
		await this.toggleUsb(false, 4);
		await this.testBot.powerOffDUT();
	}

	async powerOn() {
		console.log('Powering on RPI 243390');
		await this.toggleUsb(false, 4);
		await Bluebird.delay(1000 * 8);
		await this.testBot.setVout(this.powerVoltage);
		await this.testBot.powerOnDUT();
	}

	protected async powerOnFlash() {
		await this.toggleUsb(false, 4);
		await Bluebird.delay(1000); // Wait 1s before trying to turning USB back on
		await this.toggleUsb(true, 4);
		await Bluebird.delay(5000);
		await this.testBot.setVout(this.powerVoltage);
		await this.testBot.powerOnDUT();
	}
}

/** Implementation for Intel NUC devices. */
export class IntelNuc extends DeviceInteractor {
	constructor(testBot: TestBot) {
		super(testBot, 12);
	}

	async powerOn() {
		await this.testBot.powerOffDUT();
		await this.testBot.setVout(this.powerVoltage);
		await this.testBot.switchSdToDUT(5000); // Wait for 5s after toggling mux, to ensure that the mux is toggled to DUT before powering it on
		await this.testBot.powerOnDUT();

		await Bluebird.delay(5000); // Wait 5s before measuring current for the first time, or we may power off again during flashing!
		let current = await this.testBot.readVoutAmperage();
		let timedOut = 0;
		console.log('Initial current measurement:' + current + ' Amps');

		const timeoutHandle = setTimeout(() => {
			timedOut = 1;
		}, 360000); // 6 minute timeout

		while (current > 0.1 && timedOut === 0) {
			await Bluebird.delay(5000); // Wait 5s before measuring current again.
			current = await this.testBot.readVoutAmperage();
			console.log(
				'Awaiting DUT to flash and power down, current: ' + current + ' Amps',
			);
		}

		clearTimeout(timeoutHandle);
		if (timedOut === 1) {
			throw new Error('Timed out while waiting for DUT to flash');
		} else {
			console.log('Internally flashed - powering off DUT');
			// Once current has dropped below the threshold, power off and toggle mux.
			await this.testBot.powerOffDUT();
			await this.testBot.switchSdToHost(1000);
			// Turn power back on, this should now get the NUC to boot from internal mmc as USB is no longer connected.
			await this.testBot.powerOnDUT();
			console.log('Powering on DUT - should now boot from internal storage');
		}
	}
}
