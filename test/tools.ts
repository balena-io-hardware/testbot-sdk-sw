import { https } from 'follow-redirects';
import * as fs from 'fs';
import {
	IntelNuc,
	RaspberryPi,
	BalenaFin,
	BalenaFinV09,
	TestBotHat,
	RevPiCore3,
} from '../lib';
import { getSdk } from 'balena-sdk';

// Dockerfile defines a volume at this path.
const imagesPath = '/images';

export async function resolveDutOsImage(dutType: string) {
	const info = await resolveImageInfo(dutType);
	return await downloadOsImage(info.deviceType, info.version);
}

const resolveImageInfo = async (dutType: string) => {
	switch (dutType) {
		case 'fincm3': {
			return {
				deviceType: 'fincm3',
				version: await resolveDutOsVersion(),
			};
		}
		case 'intel-nuc': {
			return {
				deviceType: 'intel-nuc',
				version: await resolveDutOsVersion(),
			};
		}
		case 'revpi-core-3': {
			return {
				deviceType: 'revpi-core-3',
				version: await resolveDutOsVersion(),
			};
		}
		default: {
			return {
				deviceType: dutType,
				version: await resolveDutOsVersion(),
			};
		}
	}
};

export const downloadOsImage = async (
	type: string,
	version: string | undefined,
): Promise<string> => {
	const dstFileName = `${imagesPath}/balenaOs-${type}-${version}.gz`;

	if (fs.existsSync(dstFileName)) {
		console.log(`Using existing OS image: ${dstFileName}`);
		return dstFileName;
	}

	return await new Promise((resolve, reject) => {
		const dst = fs.createWriteStream(dstFileName);
		const url = `https://api.balena-cloud.com/download?deviceType=${type}&version=${version}&fileType=.gz`;

		console.log(`Downloading OS image to ${dstFileName} using ${url}`);
		https
			.get(url, (resp) => {
				resp.pipe(dst);
				dst.on('finish', () => {
					console.log('Image download is completed');
					resolve(dstFileName);
				});
			})
			.on('error', (err) => {
				fs.unlink(dstFileName, () => {
					// Ignore.
				});
				reject(`downloadOsImage() method failed - ${err}`);
			});
	});
};

export async function resolveDutOsVersion() {
	const balena = getSdk({
		apiUrl: 'https://api.balena-cloud.com',
	});
	const osVersions = await balena.models.hostapp.getAllOsVersions([
		resolveDutType(),
	]);
	for (const key in osVersions[resolveDutType()]) {
		if (
			osVersions[resolveDutType()][key].variant === 'dev' &&
			osVersions[resolveDutType()][key].osType === 'default'
		) {
			return osVersions[resolveDutType()][key].rawVersion;
		}
	}
}

export function resolveDutType() {
	if (process.env.TESTBOT_DUT_TYPE) {
		return process.env.TESTBOT_DUT_TYPE;
	}
	// For backward compatibility with existing devices.
	// This should not be documented.
	if (process.env.E2E_DUT_TYPE) {
		return process.env.E2E_DUT_TYPE;
	}
	return 'raspberrypi3';
}

export function createDeviceInteractor(testbotHat: TestBotHat) {
	const dutType = resolveDutType();
	switch (dutType) {
		case 'fincm3': {
			// check environment variable to see if using balenaFin v1.0.0 (V09)
			if (process.env.BALENA_FIN_V09 === 'true') {
				return new BalenaFinV09(testbotHat);
			}
			return new BalenaFin(testbotHat);
		}
		case 'intel-nuc': {
			return new IntelNuc(testbotHat);
		}
		case 'revpi-core-3': {
			return new RevPiCore3(testbotHat);
		}
		default: {
			return new RaspberryPi(testbotHat);
		}
	}
}
