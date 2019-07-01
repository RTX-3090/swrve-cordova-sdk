const fs = require('fs');
const path = require('path');
const xcode = require('xcode');
const swrveUtils = require('./swrve-utils');
const util = require('util'); // requires Node 8.16+
var appConfig;

module.exports = function(context) {
	appConfig = swrveUtils.cordovaAppConfigForContext(context);

	if (!swrveUtils.isUsingSwrveHooks(appConfig, 'ios')) {
		console.log('Swrve: No preferences found for ios platform in config.xml.');
		return;
	}

	const hasPushEnabled = appConfig.getPlatformPreference('swrve.pushEnabled', 'ios');

	if (hasPushEnabled != undefined && hasPushEnabled) {
		iosSetupServiceExtension();
	}
};

async function iosSetupServiceExtension() {
	const appGroupIdentifier = appConfig.getPlatformPreference('swrve.appGroupIdentifier', 'ios');
	const appName = appConfig.name();
	const packageName = appConfig.packageName();
	const iosPath = 'platforms/ios/';
	const projPath = `${iosPath}${appName}.xcodeproj/project.pbxproj`;
	const extName = 'SwrvePushExtension';
	const copyFilePromisify = util.promisify(fs.copyFile);
	var extFiles = [ 'NotificationService.h', 'NotificationService.m', `${extName}-Info.plist` ];

	if (appGroupIdentifier != undefined) {
		extFiles.push(`Entitlements-${extName}.plist`);
	}

	// The directory where the source extension files and common are stored
	const sourceDir = `plugins/cordova-plugin-swrve/platforms/ios/${extName}/`;
	const swrveSDKCommonDirectory = path.join(`${appName}`, 'Plugins', 'cordova-plugin-swrve');
	const proj = xcode.project(projPath);
	proj.parseSync();

	if (!fs.existsSync(`${iosPath}${extName}`)) {
		console.log(`Adding ${extName} Push Service Extension to ${appName}...`);
		// Copy in the extension files
		fs.mkdirSync(`${iosPath}${extName}`);

		try {
			// using a promise to ensure all files finished copying before moving on
			await Promise.all(
				extFiles.map((file) => copyFilePromisify(`${sourceDir}${file}`, `${iosPath}${extName}/${file}`))
			);

			// Add a target for the extension
			let extTarget = proj.addTarget(extName, 'app_extension');

			// Create new PBXGroup for the extension
			let extGroup = proj.addPbxGroup(extFiles, extName, extName);

			// Add to PBXGroup under to CustomTemplate so files appear in the file explorer in Xcode
			let groups = proj.hash.project.objects['PBXGroup'];
			Object.keys(groups).forEach(function(key) {
				if (groups[key].name === 'CustomTemplate') {
					proj.addToPbxGroup(extGroup.uuid, key);
				}
			});

			// Add build phases
			proj.addBuildPhase([ 'NotificationService.m' ], 'PBXSourcesBuildPhase', 'Sources', extTarget.uuid);
			proj.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', extTarget.uuid);

			// Iterate through the entire XCBuildConfig for config of the new target PRODUCT_NAME and modify it
			var config = proj.hash.project.objects['XCBuildConfiguration'];
			for (var ref in config) {
				if (
					config[ref].buildSettings !== undefined &&
					config[ref].buildSettings.PRODUCT_NAME !== undefined &&
					config[ref].buildSettings.PRODUCT_NAME.includes(extTarget.pbxNativeTarget.productName)
				) {
					var INHERITED = '"$(inherited)"';
					if (
						!config[ref].buildSettings['FRAMEWORK_SEARCH_PATHS'] ||
						config[ref].buildSettings['FRAMEWORK_SEARCH_PATHS'] === INHERITED
					) {
						proj.hash.project.objects['XCBuildConfiguration'][ref].buildSettings[
							'FRAMEWORK_SEARCH_PATHS'
						] = [ INHERITED ];
					}

					// Set entitlements
					if (appGroupIdentifier != undefined) {
						proj.hash.project.objects['XCBuildConfiguration'][ref].buildSettings[
							'CODE_SIGN_ENTITLEMENTS'
						] = `"$(PROJECT_DIR)/SwrvePushExtension/Entitlements-SwrvePushExtension.plist"`;
					}

					// Fix issues with the framework search paths, deployment target and bundle id
					proj.hash.project.objects['XCBuildConfiguration'][ref].buildSettings['FRAMEWORK_SEARCH_PATHS'].push(
						`"${swrveSDKCommonDirectory}"`
					);
					proj.hash.project.objects['XCBuildConfiguration'][ref].buildSettings['IPHONEOS_DEPLOYMENT_TARGET'] =
						'10.0';
					proj.hash.project.objects['XCBuildConfiguration'][ref].buildSettings[
						'PRODUCT_BUNDLE_IDENTIFIER'
					] = `${packageName}.ServiceExtension`;
				}
			}

			fs.writeFileSync(projPath, proj.writeSync());
			console.log(`Successfully added ${extName} service extension to ${appName}`);

			// now that everything is setup, modify included files to config.json
			iosSetupServiceExtensionAppGroup();
		} catch (err) {
			console.error(`There was an issue creating the Swrve Service Extension: ${err}`);
		}
	} else {
		console.log(`Swrve: ${extName} already exists at ${iosPath}`);
	}
}

function iosSetupServiceExtensionAppGroup() {
	const appGroupIdentifier = appConfig.getPlatformPreference('swrve.appGroupIdentifier', 'ios');

	if (appGroupIdentifier !== undefined) {
		const notificationServicePath = path.join('platforms', 'ios', 'SwrvePushExtension', 'NotificationService.m');
		const notificationServiceEntitlementsPath = path.join(
			'platforms',
			'ios',
			'SwrvePushExtension',
			'Entitlements-SwrvePushExtension.plist'
		);

		// modify NotificationService.m
		fs.readFile(notificationServicePath, 'utf-8', (err, data) => {
			if (!data.includes(`withAppGroupIdentifier:@"${appGroupIdentifier}"`)) {
				var updatedServiceNotification = data.replace(
					'withAppGroupIdentifier:nil',
					`withAppGroupIdentifier:@"${appGroupIdentifier}"`
				);
				fs.writeFileSync(notificationServicePath, updatedServiceNotification, 'utf-8');
			} else {
				console.log('AppGroup was already inside the NotificationService.m file');
			}
		});

		// modify entitlements file
		fs.readFile(notificationServiceEntitlementsPath, 'utf-8', (err, data) => {
			if (!data.includes(`<string>${appGroupIdentifier}</string>`)) {
				var updatedEntitlements = data.replace(
					'<string>APP_GROUP_TEMP</string>',
					`<string>${appGroupIdentifier}</string>`
				);
				fs.writeFileSync(notificationServiceEntitlementsPath, updatedEntitlements, 'utf-8');
			} else {
				console.log('AppGroup was already on the entitlements file');
			}
		});
	} else {
		console.warn('There was no appGroupIdentifier found in config.xml');
	}
}
