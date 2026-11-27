import fs from 'fs';
import path from 'path';

const rootDir = process.cwd();
const androidAppDir = path.join(rootDir, 'android', 'app');
const buildGradlePath = path.join(androidAppDir, 'build.gradle');
const manifestPath = path.join(androidAppDir, 'src', 'main', 'AndroidManifest.xml');
const signingDir = path.join(rootDir, 'android-signing');
const propsPath = path.join(signingDir, 'keystore.properties');

if (!fs.existsSync(buildGradlePath)) {
  console.error('android/app/build.gradle not found. Run "npx cap add android" first.');
  process.exit(1);
}

// Copy keystore & properties into android/app/ if present
if (fs.existsSync(propsPath)) {
  fs.copyFileSync(propsPath, path.join(androidAppDir, 'keystore.properties'));

  const propsRaw = fs.readFileSync(propsPath, 'utf8');
  const match = propsRaw.match(/^storeFile=(.+)$/m);
  if (match) {
    const storeFileName = match[1].trim();
    const srcKeystore = path.isAbsolute(storeFileName)
      ? storeFileName
      : path.join(signingDir, storeFileName);
    if (fs.existsSync(srcKeystore)) {
      fs.copyFileSync(srcKeystore, path.join(androidAppDir, path.basename(storeFileName)));
    }
  }
}

let gradle = fs.readFileSync(buildGradlePath, 'utf8');

if (!gradle.includes('signingConfigs')) {
  const signingBlock = `
    signingConfigs {
        release {
            def keystorePropertiesFile = file("keystore.properties")
            if (keystorePropertiesFile.exists()) {
                def keystoreProperties = new Properties()
                keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
                storeFile file(keystoreProperties['storeFile'])
                storePassword keystoreProperties['storePassword']
                keyAlias keystoreProperties['keyAlias']
                keyPassword keystoreProperties['keyPassword']
            }
        }
    }
`;

  gradle = gradle.replace(/android\s*\{/, `android {\n${signingBlock}`);
}

if (!gradle.includes('signingConfig signingConfigs.release')) {
  gradle = gradle.replace(
    /(buildTypes\s*\{\s*release\s*\{)/,
    `$1\n            if (file("keystore.properties").exists()) {\n                signingConfig signingConfigs.release\n            }`
  );
}

fs.writeFileSync(buildGradlePath, gradle, 'utf8');
console.log('Configured Android release signing in android/app/build.gradle.');

// Ensure network & file upload permissions in AndroidManifest.xml
if (fs.existsSync(manifestPath)) {
  let manifest = fs.readFileSync(manifestPath, 'utf8');
  if (!manifest.includes('android.permission.INTERNET')) {
    manifest = manifest.replace(
      '<application',
      '    <uses-permission android:name="android.permission.INTERNET" />\n    <application'
    );
    fs.writeFileSync(manifestPath, manifest, 'utf8');
  }
}
