const path = require('path');
const {EventEmitter} = require('events');
const util = require('util');
const os = require('os');
const fs = require('fs');
const md5 = require('md5');
const admin = require('firebase-admin');
const {Firestore, WriteBatch, CollectionReference, FieldValue, FieldPath, Timestamp} = require('@google-cloud/firestore');
const semver = require('semver');
const asyncHooks = require('async_hooks');
const callsites = require('callsites');

const readFile = util.promisify(fs.readFile);
const readdir = util.promisify(fs.readdir);
const stat = util.promisify(fs.stat);
const exists = util.promisify(fs.exists);

const cryptoHack = require('./async-crypto-hack')
cryptoHack.enable()

// Track stats and dryrun setting so we only proxy once.
// Multiple proxies would create a memory leak.
const statsMap = new Map();

let proxied = false;
function proxyWritableMethods() {
	// Only proxy once
	if (proxied) return;
	else proxied = true;

	const ogCommit = WriteBatch.prototype._commit;
	WriteBatch.prototype._commit = async function() {
		// Empty the queue
		while (this._fireway_queue && this._fireway_queue.length) {
			this._fireway_queue.shift()();
		}
		for (const [stats, {dryrun}] of statsMap.entries()) {
			if (this._firestore._fireway_stats === stats) {
				if (dryrun) return [];
			}
		}
		return ogCommit.apply(this, Array.from(arguments));
	};

	const skipWriteBatch = Symbol('Skip the WriteBatch proxy');

	function mitm(obj, key, fn) {
		const original = obj[key];
		obj[key] = function() {
			const args = [...arguments];
			for (const [stats, {log}] of statsMap.entries()) {
				if (this._firestore._fireway_stats === stats) {

					// If this is a batch
					if (this instanceof WriteBatch) {
						const [_, doc] = args;
						if (doc && doc[skipWriteBatch]) {
							delete doc[skipWriteBatch];
						} else {
							this._fireway_queue = this._fireway_queue || [];
							this._fireway_queue.push(() => {
								fn.call(this, args, (stats.frozen ? {} : stats), log);
							});
						}
					} else {
						fn.call(this, args, (stats.frozen ? {} : stats), log);
					}
				}
			}
			return original.apply(this, args);
		}
	}

	// Add logs for each WriteBatch item
	mitm(WriteBatch.prototype, 'create', ([_, doc], stats, log) => {
		stats.created += 1;
		log('Creating', JSON.stringify(doc));
	});

	mitm(WriteBatch.prototype, 'set', ([ref, doc, opts = {}], stats, log) => {
		stats.set += 1;
		log(opts.merge ? 'Merging' : 'Setting', ref.path, JSON.stringify(doc));
	});

	mitm(WriteBatch.prototype, 'update', ([ref, doc], stats, log) => {
		stats.updated += 1;
		log('Updating', ref.path, JSON.stringify(doc));
	});

	mitm(WriteBatch.prototype, 'delete', ([ref], stats, log) => {
		stats.deleted += 1;
		log('Deleting', ref.path);
	});

	mitm(CollectionReference.prototype, 'add', ([doc], stats, log) => {
		doc[skipWriteBatch] = true;
		stats.added += 1;
		log('Adding', JSON.stringify(doc));
	});
}

class HookMetadata {
	constructor(asyncId, type, call) {
		this.asyncId = asyncId;
		this.type    = type;
		this.call    = call;
	}

	toString() {
		return `${this.asyncId} - ${this.type} ${this.call.getFileName()}#${this.call.getFunctionName()} @ ${this.call.getLineNumber()}:${this.call.getColumnNumber()}`;
	}
}
const dontTrack = Symbol('Skip async tracking to short circuit');
async function trackAsync({log, file, forceWait}, fn) {
	// Store metadata about async handles
	const activeHandles = new Map();
	const emitter = new EventEmitter();

	function deleteHandle(asyncId, reason) {
		const metadata = activeHandles.get(asyncId);
		if (!metadata) return

		activeHandles.delete(asyncId);
		emitter.emit('deleted', asyncId);

		if (activeHandles.size !== 0) return
		emitter.emit('empty');
	}

	async function waitForAllHandlesToBeDeleted() {
		const maxWaitTimeSecs = 30;
		let waitTimeSecs = 0;
		while (true) {
			if (activeHandles.size === 0) {
				return true;
			}

			waitTimeSecs++;
			if (waitTimeSecs > maxWaitTimeSecs) {
				console.log(`Took longer than ${maxWaitTimeSecs} seconds for active handles to be closed. Failing.`)
				return false
			}

			console.log(`Waiting one second ${waitTimeSecs} / ${maxWaitTimeSecs} for all handles to close`)
			await new Promise(r => setTimeout(() => r(), 1000));
		}
	}

	const hook = asyncHooks.createHook({
		init(asyncId, type) {
			for (const call of callsites()) {
				// Prevent infinite loops
				const calledFn = call.getFunction();
				if (calledFn && calledFn[dontTrack]) {
					return;
				}

				const name = call.getFileName();

				if (
					!name ||
					name === __filename ||
					name.startsWith('node:internal/') ||
					name.startsWith('internal/') ||
					name.startsWith('timers.js')
				) continue;

				if (name === file.path) {
					const metadata = new HookMetadata(asyncId, type, call)

					activeHandles.set(asyncId, metadata);
					break;
				}
			}
		},
		before:         id => deleteHandle(id, 'before'),
		after:          id => deleteHandle(id, 'after'),
		promiseResolve: id => deleteHandle(id, 'promiseResolve'),
	}).enable();

	function friendlyHandles() {
		return Array.from(activeHandles.values()).map(h => h.toString());
	}

	async function handleCheck() {
		if (activeHandles.size === 0) return;
		if (forceWait) {
			console.log('Waiting for async calls to resolve');
			await waitForAllHandlesToBeDeleted();
		} else {
			// This always logs in Node <12
			const nodeVersion = semver.coerce(process.versions.node);
			if (nodeVersion.major >= 12) {
				console.warn(
					'WARNING: fireway detected open async calls. Use --forceWait if you want to wait:',
					friendlyHandles()
				);
			}
		}
	}

	let rejection;
	const unhandled = reason => rejection = reason;
	process.once('unhandledRejection', unhandled);
	process.once('uncaughtException', unhandled);

	try {
		const res = await fn();
		await handleCheck();

		// Wait a tick or so for the unhandledRejection
		await new Promise(r => setTimeout(() => r(), 1));

		process.removeAllListeners('unhandledRejection');
		process.removeAllListeners('uncaughtException');
		if (rejection) {
			log(`Error in ${file.filename}`, rejection);
			return false;
		}
		return res;
	} catch(e) {
		log(e);
		return false;
	} finally {
		hook.disable();
	}
}
trackAsync[dontTrack] = true;

async function migrate({path: dir, projectId, storageBucket, dryrun, app, debug = false, require: req, forceWait = false} = {}) {
	if (req) {
		try {
			require(req);
		} catch (e) {
			console.error(e);
			throw new Error(`Trouble executing require('${req}');`);
		}
	}

	const log = function() {
		return debug && console.log.apply(console, arguments);
	}

	const stats = {
		scannedFiles: 0,
		executedFiles: 0,
		created: 0,
		set: 0,
		updated: 0,
		deleted: 0,
		added: 0
	};

	// Get all the scripts
	if (!path.isAbsolute(dir)) {
		dir = path.join(process.cwd(), dir);
	}

	if (!(await exists(dir))) {
		throw new Error(`No directory at ${dir}`);
	}

	const filenames = [];
	for (const file of await readdir(dir)) {
		if (!(await stat(path.join(dir, file))).isDirectory()) {
			filenames.push(file);
		}
	}

	// Parse the version numbers from the script filenames
	const versionToFile = new Map();
	let files = filenames.map(filename => {
		// Skip files that start with a dot
		if (filename[0] === '.') return;

		const [filenameVersion, description] = filename.split('__');
		const coerced = semver.coerce(filenameVersion);

		if (!coerced) {
			if (description) {
				// If there's a description, we assume you meant to use this file
				log(`WARNING: ${filename} doesn't have a valid semver version`);
			}
			return null;
		}

		// If there's a version, but no description, we have an issue
		if (!description) {
			throw new Error(`This filename doesn't match the required format: ${filename}`);
		}

		const {version} = coerced;

		const existingFile = versionToFile.get(version);
		if (existingFile) {
			throw new Error(`Both ${filename} and ${existingFile} have the same version`);
		}
		versionToFile.set(version, filename);

		return {
			filename,
			path: path.join(dir, filename),
			version,
			description: path.basename(description, path.extname(description))
		};
	}).filter(Boolean);

	stats.scannedFiles = files.length;
	log(`Found ${stats.scannedFiles} migration files`);

	// Find the files after the latest migration number
	statsMap.set(stats, {dryrun, log});
	dryrun && log('Making firestore read-only');
	proxyWritableMethods();

	if (!storageBucket && projectId) {
		storageBucket = `${projectId}.appspot.com`;
	}

	const providedApp = app;
	if (!app) {
		app = admin.initializeApp({
			projectId,
			storageBucket
		});
	}

	// Use Firestore directly so we can mock for dryruns
	const firestore = new Firestore({projectId});
	firestore._fireway_stats = stats;

	const collection = firestore.collection('fireway');

	// Get the latest migration
	const result = await collection
		.orderBy('installed_rank', 'desc')
		.limit(1)
		.get();
	const [latestDoc] = result.docs;
	const latest = latestDoc && latestDoc.data();

	if (latest && !latest.success) {
		throw new Error(`Migration to version ${latest.version} using ${latest.script} failed! Please restore backups and roll back database and code!`);
	}

	let installed_rank;
	if (latest) {
		files = files.filter(file => semver.gt(file.version, latest.version));
		installed_rank = latest.installed_rank;
	} else {
		installed_rank = -1;
	}

	// Sort them by semver
	files.sort((f1, f2) => semver.compare(f1.version, f2.version));

	log(`Executing ${files.length} migration files`);

	// Execute them in order
	for (const file of files) {
		stats.executedFiles += 1;
		log('Running', file.filename);

		let migration;
		try {
			migration = require(file.path);
		} catch (e) {
			log(e);
			throw e;
		}

		let start, finish;
		const success = await trackAsync({log, file, forceWait}, async () => {
			start = new Date();
			try {
				await migration.migrate({app, firestore, FieldValue, FieldPath, Timestamp, dryrun});
				return true;
			} catch(e) {
				log(`Error in ${file.filename}`, e);
				return false;
			} finally {
				finish = new Date();
			}
		});

		// Upload the results
		log(`Uploading the results for ${file.filename}`);

		// Freeze stat tracking
		stats.frozen = true;

		installed_rank += 1;
		const id = `${installed_rank}-${file.version}-${file.description}`;
		await collection.doc(id).set({
			installed_rank,
			description: file.description,
			version: file.version,
			script: file.filename,
			type: path.extname(file.filename).slice(1),
			checksum: md5(await readFile(file.path)),
			installed_by: os.userInfo().username,
			installed_on: start,
			execution_time: finish - start,
			success
		});

		// Unfreeze stat tracking
		delete stats.frozen;

		if (!success) {
			throw new Error('Stopped at first failure');
		}
	}

	// Ensure firebase terminates
	if (!providedApp) {
		app.delete();
	}

	const {scannedFiles, executedFiles, added, created, updated, set, deleted} = stats;
	log('Finished all firestore migrations');
	log(`Files scanned:${scannedFiles} executed:${executedFiles}`);
	log(`Docs added:${added} created:${created} updated:${updated} set:${set} deleted:${deleted}`);

	statsMap.delete(stats);

	return stats;
}

module.exports = {migrate};
