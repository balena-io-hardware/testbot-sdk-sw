import * as repl from 'repl';
import { TestBotHat } from '../lib';
import { createDeviceInteractor, downloadOsImage } from './tools';

// Initialize the node REPL making the testbot SDK available as testbot variable.

const testbot = new TestBotHat((msg) => console.log(`testbot: ${msg}`));
testbot.setup().then(() => {
	const replServer = repl.start();
	replServer.context['testbot'] = testbot;
	replServer.context['interactor'] = createDeviceInteractor(testbot);
	replServer.context['downloadOsImage'] = downloadOsImage;

	replServer.on('exit', () => {
		testbot.teardown(true);
	});
});
