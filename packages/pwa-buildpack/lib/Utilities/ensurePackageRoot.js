/**
 * Given a package name, return an absolute path on the filesystem where the
 * files for that package can be found.
 *
 * If the package name is an NPM package, and it is not available locally,
 * this command will run a remote fetch to NPM to get the tarball and unzip it.
 */
const path = require('path');
const os = require('os');
const fse = require('fs-extra');
const tar = require('tar');
const fetch = require('node-fetch');
const pkgDir = require('pkg-dir');
const execa = require('execa');
const prettyLogger = require('../util/pretty-logger');

module.exports = async function ensurePackageRoot(
    packageName,
    { installIfDownloaded } = {}
) {
    try {
        await fse.readdir(packageName);
        prettyLogger.info(`Found ${packageName} directory`);
        // if that succeeded, then...
        return packageName;
    } catch (e) {
        if (e.code !== 'ENOENT') {
            // A missing directory is recoverable, we look for it other ways
            // below. A different filesystem error is not expected.
            throw e;
        }
    }
    // OK, it's not a relative or absolute directory. Maybe the package is
    // already an available module!
    try {
        return pkgDir.sync(require.resolve(packageName));
    } catch (e) {
        // Maybe it doesn't have an index file and require.resolve hates that.
        // It will at least have a package.json if it's an installed package.
        try {
            const pkgPath = pkgDir.sync(
                path.resolve(packageName, 'package.json')
            );
            if (pkgPath) {
                return pkgPath;
            }
        } catch (e) {
            // pkgDir.sync threw an exception, must continue
        }
        // or pkgDir.sync did not return a string path, must continue
    }

    // okay, we need to download the package after all.
    const tempPackageDir = path.resolve(os.tmpdir(), packageName);
    // NPM extracts a tarball to './package'
    const packageRoot = path.resolve(tempPackageDir, 'package');
    let tarballUrl;
    try {
        prettyLogger.info(`Finding ${packageName} tarball on NPM`);
        tarballUrl = JSON.parse(
            execa.shellSync(`npm view --json ${packageName}`, {
                encoding: 'utf-8'
            }).stdout
        ).dist.tarball;
    } catch (e) {
        throw new Error(
            `Invalid template: could not get tarball url from npm: ${e.message}`
        );
    }

    let tarballStream;
    try {
        prettyLogger.info(`Downloading and unpacking ${tarballUrl}`);
        tarballStream = (await fetch(tarballUrl)).body;
    } catch (e) {
        throw new Error(
            `Invalid template: could not download tarball from NPM: ${
                e.message
            }`
        );
    }

    await fse.ensureDir(tempPackageDir);
    return new Promise((res, rej) => {
        const untarStream = tar.extract({
            cwd: tempPackageDir
        });
        tarballStream.pipe(untarStream);
        untarStream.on('finish', () => {
            prettyLogger.info(`Unpacked ${packageName}.`);
            if (installIfDownloaded) {
                execa.shell('npm ci', {
                    stdio: 'inherit',
                    cwd: packageRoot
                }).then(() => res(packageRoot));
            } else {
                res(packageRoot);
            }
        });
        untarStream.on('error', rej);
        tarballStream.on('error', rej);
    });
};
