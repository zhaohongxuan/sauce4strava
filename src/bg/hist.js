/* global sauce, browser */

sauce.ns('hist', async ns => {
    'use strict';

    const namespace = 'hist';
    const extUrl = browser.runtime.getURL('');
    const jobs = await sauce.getModule(extUrl + 'src/common/jscoop/jobs.js');
    const queues = await sauce.getModule(extUrl + 'src/common/jscoop/queues.js');
    const futures = await sauce.getModule(extUrl + 'src/common/jscoop/futures.js');
    const locks = await sauce.getModule(extUrl + 'src/common/jscoop/locks.js');
    const DBTrue = 1;
    const DBFalse = 0;

    const actsStore = new sauce.hist.db.ActivitiesStore();
    const streamsStore = new sauce.hist.db.StreamsStore();
    const athletesStore = new sauce.hist.db.AthletesStore();


    sauce.hist.db.ActivityModel.setSyncManifest('streams', [{
        version: 1,
        errorBackoff: 86400 * 1000,
        data: new Set([
            'time',
            'heartrate',
            'altitude',
            'distance',
            'moving',
            'velocity_smooth',
            'cadence',
            'latlng',
            'watts',
            'watts_calc',
            'grade_adjusted_distance',
            'temp',
        ])
    }]);

    sauce.hist.db.ActivityModel.setSyncManifest('local', [{
        version: 15,
        errorBackoff: 3600 * 1000,
        data: activeStreamProcessor
    }, {
        version: 16,
        errorBackoff: 300 * 1000,
        data: runningWattsProcessor
    }, {
        version: 17,
        errorBackoff: 300 * 1000,
        data: activityStatsProcessor
    }]);


    async function getActivitiesStreams(activities, streams) {
        const ids = new Set(Array.from(activities).map(x => x.get('id')));
        const actStreams = new Map();
        if (ids.size > 50) {  // 50 is profile tuned.
            const athletes = new Set();
            for (const x of activities) {
                athletes.add(x.get('athlete'));
            }
            const streamKeys = [];
            for (const x of athletes) {
                for (const [id, stream] of await streamsStore.getAllKeysForAthlete(x)) {
                    if (ids.has(id) && streams.has(stream)) {
                        streamKeys.push([id, stream]);
                    }
                }
            }
            for (const x of await streamsStore.getMany(streamKeys)) {
                if (!actStreams.has(x.activity)) {
                    actStreams.set(x.activity, {});
                }
                actStreams.get(x.activity)[x.stream] = x.data;
            }
        } else {
            for (const x of ids) {
                actStreams.set(x, await streamsStore.activityStreams(x));
            }
        }
        return actStreams;
    }


    async function activeStreamProcessor({activities, athlete}) {
        const actStreams = await getActivitiesStreams(activities,
            new Set(['time', 'moving', 'cadence', 'watts', 'distance']));
        const activeStreams = [];
        for (const activity of activities) {
            const streams = actStreams.get(activity.get('id'));
            const isTrainer = activity.get('trainer');
            try {
                const activeStream = sauce.data.createActiveStream(streams, {isTrainer});
                activeStreams.push({
                    activity: activity.get('id'),
                    athlete: athlete.get('id'),
                    stream: 'active',
                    data: activeStream
                });
            } catch(e) {
                console.warn("Failed to create active stream for: " + activity);
                activity.setSyncError('local', e);
                continue;
            }
        }
        await streamsStore.putMany(activeStreams);
    }


    async function runningWattsProcessor({activities, athlete}) {
        const runs = Array.from(activities).filter(x => x.get('basetype') === 'run');
        const actStreams = await getActivitiesStreams(activities,
            new Set(['time', 'grade_adjusted_distance']));
        const wattsStreams = [];
        for (const activity of runs) {
            const streams = actStreams.get(activity.get('id'));
            const gap = streams.grade_adjusted_distance;
            if (!gap) {
                continue;
            }
            const weight = athlete.getWeightAt(activity.get('ts'));
            if (!weight) {
                activity.setSyncError('local', new Error("No weight for athlete, try later..."));
                continue;
            }
            try {
                const wattsStream = [0];
                for (let i = 1; i < gap.length; i++) {
                    const dist = gap[i] - gap[i - 1];
                    const time = streams.time[i] - streams.time[i - 1];
                    const kj = sauce.pace.work(weight, dist);
                    wattsStream.push(kj * 1000 / time);
                }
                wattsStreams.push({
                    activity: activity.get('id'),
                    athlete: athlete.get('id'),
                    stream: 'watts_calc',
                    data: wattsStream
                });
            } catch(e) {
                console.warn("Failed to create active stream for: " + activity);
                activity.setSyncError('local', e);
                continue;
            }
        }
        await streamsStore.putMany(wattsStreams);
    }


    async function activityStatsProcessor({activities, athlete}) {
        const actStreams = await getActivitiesStreams(activities,
            new Set(['time', 'heartrate', 'active', 'watts', 'watts_calc']));
        if (athlete.get('hrZones') === undefined) {
            console.info("Getting HR zones for: " + athlete);
            // The API is based on an activity but it's global to the athlete..
            await athlete.save({hrZones: (await sauce.perf.fetchHRZones(activities[0].get('id'))) || null});
        }
        const hrZones = athlete.get('hrZones');
        const ltHR = hrZones && (hrZones.z4 + hrZones.z3) / 2;
        const maxHR = hrZones && sauce.perf.estimateMaxHR(hrZones);
        for (const activity of activities) {
            const ftp = athlete.getFTPAt(activity.get('ts'));
            const streams = actStreams.get(activity.get('id'));
            const stats = {};
            if (streams.heartrate) {
                if (hrZones) {
                    try {
                        const restingHR = ftp ? sauce.perf.estimateRestingHR(ftp) : 60;
                        stats.tTss = sauce.perf.tTSS(streams.heartrate, streams.time, streams.active,
                            ltHR, restingHR, maxHR, athlete.get('gender'));
                    } catch(e) {
                        activity.setSyncError('local', e);
                        continue;
                    }
                }
            }
            if (ftp && (streams.watts || streams.watts_calc)) {
                try {
                    const corrected = sauce.power.correctedPower(streams.time, streams.watts || streams.watts_calc);
                    if (!corrected) {
                        continue;
                    }
                    const activeTime = sauce.data.activeTime(streams.time, streams.active);
                    stats.kj = corrected.kj();
                    stats.power = stats.kj * 1000 / activeTime;
                    stats.tss = sauce.power.calcTSS(stats.np || stats.power, activeTime, ftp);
                    if (streams.watts || activity.get('basetype') === 'run') {
                        stats.np = corrected.np();
                        stats.xp = corrected.xp();
                    }
                    stats.tss = sauce.power.calcTSS(stats.np || stats.power, activeTime, ftp);
                    stats.intensity = (stats.np || stats.power) / ftp;
                } catch(e) {
                    activity.setSyncError('local', e);
                    continue;
                }
            }
            activity.set({stats});
        }
    }


    class FetchError extends Error {
        static fromResp(resp) {
            const msg = `${this.name}: ${resp.url} [${resp.status}]`;
            const instance = new this(msg);
            instance.resp = resp;
            return instance;
        }
    }

    class ThrottledFetchError extends FetchError {}


    async function sleep(ms) {
        await new Promise(resolve => setTimeout(resolve, ms));
    }


    async function retryFetch(urn, options={}) {
        const maxRetries = 5;
        const headers = options.headers || {};
        headers["x-requested-with"] = "XMLHttpRequest";  // Required for most Strava endpoints
        const url = `https://www.strava.com${urn}`;
        for (let r = 1;; r++) {
            const resp = await fetch(url, Object.assign({headers}, options));
            if (resp.ok) {
                return resp;
            }
            if (resp.status >= 500 && resp.status < 600 && r <= maxRetries) {
                console.info(`Server error for: ${resp.url} - Retry: ${r}/${maxRetries}`);
                await sleep(1000 * r);
                continue;
            }
            if (resp.status === 429) {
                throw ThrottledFetchError.fromResp(resp);
            }
            throw FetchError.fromResp(resp);
        }
    }


    class SauceRateLimiter extends jobs.RateLimiter {
        async getState() {
            const storeKey = `hist-rate-limiter-${this.label}`;
            return await sauce.storage.get(storeKey);
        }

        async setState(state) {
            const storeKey = `hist-rate-limiter-${this.label}`;
            await sauce.storage.set(storeKey, state);
        }
    }


    // We must stay within API limits;  Roughly 40/min, 300/hour and 1000/day...
    let streamRateLimiterGroup;
    const getStreamRateLimiterGroup = (function() {
        return function() {
            if (!streamRateLimiterGroup) {
                const g = new jobs.RateLimiterGroup();
                g.push(new SauceRateLimiter('streams-min', {period: (60 + 5) * 1000, limit: 30, spread: true}));
                g.push(new SauceRateLimiter('streams-hour', {period: (3600 + 500) * 1000, limit: 200}));
                g.push(new SauceRateLimiter('streams-day', {period: (86400 + 3600) * 1000, limit: 700}));
                streamRateLimiterGroup = g;
            }
            return streamRateLimiterGroup;
        };
    })();


    async function incrementStreamsUsage() {
        // Used for pages to indicate they used the streams API.  This helps
        // keep us on top of overall stream usage better to avoid throttling.
        const g = getStreamRateLimiterGroup();
        await g.increment();
    }
    sauce.proxy.export(incrementStreamsUsage, {namespace});


    function getBaseType(activity) {
        if (activity.type.match(/Ride/)) {
            return 'ride';
        } else if (activity.type.match(/Run|Hike|Walk/)) {
            return 'run';
        } else if (activity.type.match(/Swim/)) {
            return 'swim';
        }
    }


    async function syncSelfActivities(athlete, options={}) {
        const knownIds = new Set(await actsStore.getAllForAthlete(athlete, {keys: true}));
        for (let concurrency = 1, page = 1, pageCount, total;; concurrency = Math.min(concurrency * 2, 25)) {
            const work = new jobs.UnorderedWorkQueue({maxPending: 25});
            for (let i = 0; page === 1 || page <= pageCount && i < concurrency; page++, i++) {
                await work.put((async () => {
                    const q = new URLSearchParams();
                    q.set('new_activity_only', 'false');
                    q.set('page', page);
                    const resp = await retryFetch(`/athlete/training_activities?${q}`);
                    return await resp.json();
                })());
            }
            if (!work.pending() && !work.fulfilled()) {
                break;
            }
            const adding = [];
            for await (const data of work) {
                if (total === undefined) {
                    total = data.total;
                    pageCount = Math.ceil(total / data.perPage);
                }
                for (const x of data.models) {
                    if (!knownIds.has(x.id)) {
                        const record = Object.assign({
                            athlete,
                            ts: x.start_date_local_raw * 1000
                        }, x);
                        record.basetype = getBaseType(record);
                        adding.push(record);
                    }
                }
            }
            // Don't give up until we've met or exceeded the indicated number of acts.
            // If a user has deleted acts that we previously fetched our count will
            // be higher.  So we also require than the entire work group had no effect
            // before stopping.
            //
            // NOTE: If the user deletes a large number of items we may end up not
            // syncing some activities.  A full resync will be required to recover.
            if (adding.length) {
                await actsStore.putMany(adding);
                console.info(`Found ${adding.length} new activities`);
            } else if (knownIds.size >= total) {
                break;
            }
        }
    }


    async function syncPeerActivities(athlete, options={}) {
        const knownIds = new Set(await actsStore.getAllForAthlete(athlete, {keys: true}));

        function *yearMonthRange(date) {
            for (let year = date.getUTCFullYear(), month = date.getUTCMonth() + 1;; year--, month=12) {
                for (let m = month; m; m--) {
                    yield [year, m];
                }
            }
        }

        async function fetchMonth(year, month) {
            // Welcome to hell.  It gets really ugly in here in an effort to avoid
            // any eval usage which is required to render this HTML into a DOM node.
            // So are doing horrible HTML parsing with regexps..
            const q = new URLSearchParams();
            q.set('interval_type', 'month');
            q.set('chart_type', 'miles');
            q.set('year_offset', '0');
            q.set('interval', '' + year +  month.toString().padStart(2, '0'));
            const resp = await retryFetch(`/athletes/${athlete}/interval?${q}`);
            const data = await resp.text();
            const raw = data.match(/jQuery\('#interval-rides'\)\.html\((.*)\)/)[1];
            const batch = [];
            const activityIconMap = {
                'icon-run': 'run',
                'icon-hike': 'run',
                'icon-walk': 'run',
                'icon-ride': 'ride',
                'icon-virtualride': 'ride',
                'icon-swim': 'swim',
                'icon-alpineski': 'ski',
                'icon-nordicski': 'ski',
                'icon-backcountryski': 'ski',
                'icon-ebikeride': 'ebike',
                'icon-workout': 'workout',
                'icon-standuppaddling': 'workout',
                'icon-yoga': 'workout',
                'icon-snowshoe': 'workout',
            };
            const attrSep = String.raw`(?: |\\"|\\')`;
            function tagWithAttrValue(tag, attrVal, matchVal) {
                return `<${tag} [^>]*?${attrSep}${matchVal ? '(' : ''}${attrVal}${matchVal ? ')' : ''}${attrSep}`;
            }
            const iconRegexps = [];
            for (const key of Object.keys(activityIconMap)) {
                iconRegexps.push(new RegExp(tagWithAttrValue('span', key, true)));
            }
            const feedEntryExp = tagWithAttrValue('div', 'feed-entry');
            const subEntryExp = tagWithAttrValue('li', 'feed-entry');
            const feedEntryRegexp = new RegExp(`(${feedEntryExp}.*?)(?=${feedEntryExp}|$)`, 'g');
            const subEntryRegexp = new RegExp(`(${subEntryExp}.*?)(?=${subEntryExp}|$)`, 'g');
            const activityRegexp = new RegExp(`^[^>]*?${attrSep}activity${attrSep}`);
            const groupActivityRegexp = new RegExp(`^[^>]*?${attrSep}group-activity${attrSep}`);
            for (const [, entry] of raw.matchAll(feedEntryRegexp)) {
                let isGroup;
                if (!entry.match(activityRegexp)) {
                    if (entry.match(groupActivityRegexp)) {
                        isGroup = true;
                    } else {
                        continue;
                    }
                }
                let basetype;
                for (const x of iconRegexps) {
                    const m = entry.match(x);
                    if (m) {
                        basetype = activityIconMap[m[1]];
                        break;
                    }
                }
                if (!basetype) {
                    console.error("Unhandled activity type for:", entry);
                    debugger;
                    basetype = 'workout'; // XXX later this is probably fine to assume.
                }
                let ts;
                const dateM = entry.match(/<time [^>]*?datetime=\\'(.*?)\\'/);
                if (dateM) {
                    const isoDate = dateM[1].replace(/ UTC$/, 'Z').replace(/ /, 'T');
                    ts = (new Date(isoDate)).getTime();
                }
                if (!ts) {
                    console.error("Unable to get timestamp from feed entry");
                    debugger;
                    ts = (new Date(`${year}-${month}`)).getTime(); // Just an approximate value for sync.
                }
                let idMatch;
                if (isGroup) {
                    for (const [, subEntry] of entry.matchAll(subEntryRegexp)) {
                        const athleteM = subEntry.match(/<a [^>]*?entry-athlete[^>]*? href=\\'\/(?:athletes|pros)\/([0-9]+)\\'/);
                        if (!athleteM) {
                            console.error("Unable to get athlete ID from feed sub entry");
                            debugger;
                            continue;
                        }
                        if (Number(athleteM[1]) !== athlete) {
                            console.warn("Skipping activity from other athlete");
                            continue;
                        }
                        idMatch = subEntry.match(/id=\\'Activity-([0-9]+)\\'/);
                        break;
                    }
                    if (!idMatch) {
                        console.error("Group activity parser failed to find activity for this athlete");
                        debugger;
                        continue;
                    }
                } else {
                    idMatch = entry.match(/id=\\'Activity-([0-9]+)\\'/);
                }
                if (!idMatch) {
                    console.error("Unable to get activity ID feed entry");
                    debugger;
                    continue;
                }
                const id = Number(idMatch[1]);
                batch.push({
                    id,
                    ts,
                    basetype,
                    athlete,
                });
            }
            return batch;
        }

        async function batchImport(startDate) {
            const minEmpty = 12;
            const minRedundant = 2;
            const iter = yearMonthRange(startDate);
            for (let concurrency = 1;; concurrency = Math.min(25, concurrency * 2)) {
                const work = new jobs.UnorderedWorkQueue({maxPending: 25});
                for (let i = 0; i < concurrency; i++) {
                    const [year, month] = iter.next().value;
                    await work.put(fetchMonth(year, month));
                }
                let empty = 0;
                let redundant = 0;
                const adding = [];
                for await (const data of work) {
                    if (!data.length) {
                        empty++;
                        continue;
                    }
                    let foundNew;
                    for (const x of data) {
                        if (!knownIds.has(x.id)) {
                            adding.push(x);
                            knownIds.add(x.id);
                            foundNew = true;
                        }
                    }
                    if (!foundNew) {
                        redundant++;
                    }
                }
                if (adding.length) {
                    await actsStore.putMany(adding);
                    console.info(`Found ${adding.length} new activities`);
                } else if (empty >= minEmpty && empty >= Math.floor(concurrency)) {
                    const [year, month] = iter.next().value;
                    const date = new Date(`${month === 12 ? year + 1 : year}-${month === 12 ? 1 : month + 1}`);
                    await actsStore.put({id: -athlete, sentinel: date.getTime()});
                    break;
                } else if (redundant >= minRedundant  && redundant >= Math.floor(concurrency)) {
                    // Entire work set was redundant.  Don't refetch any more.
                    break;
                }
            }
        }

        // Fetch latest activities (or all of them if this is the first time).
        await batchImport(new Date());
        // Sentinel is stashed as a special record to indicate that we have scanned
        // some distance into the past.  Without this we never know how far back
        // we looked given there is no page count or total to work with.
        const sentinel = await actsStore.get(-athlete);
        if (!sentinel) {
            // We never finished a prior sync so find where we left off..
            const last = await actsStore.firstForAthlete(athlete);
            await batchImport(new Date(last.ts));
        }
    }


    async function fetchStreams(activity, {cancelEvent}) {
        const q = new URLSearchParams();
        for (const m of sauce.hist.db.ActivityModel.getSyncManifest('streams')) {
            for (const x of m.data) {
                q.append('stream_types[]', x);
            }
        }
        const rateLimiters = getStreamRateLimiterGroup();
        for (let i = 1;; i++) {
            if (cancelEvent) {
                await Promise.race([rateLimiters.wait(), cancelEvent.wait()]);
                if (cancelEvent.isSet()) {
                    return;
                }
            } else {
                await rateLimiters.wait();
            }
            console.group(`Fetching streams for: ${activity.get('id')} ${new Date(activity.get('ts'))}`);
            for (const x of rateLimiters) {
                console.debug('' + x);
            }
            console.groupEnd();
            try {
                const resp = await retryFetch(`/activities/${activity.get('id')}/streams?${q}`);
                return await resp.json();
            } catch(e) {
                if (!e.resp) {
                    throw e;
                } else if (e.resp.status === 404) {
                    return null;
                } else if (e.resp.status === 429) {
                    const delay = 60000 * i;
                    console.warn(`Hit Throttle Limits: Delaying next request for ${Math.round(delay / 1000)}s`);
                    if (cancelEvent) {
                        await Promise.race([sleep(delay), cancelEvent.wait()]);
                        if (cancelEvent.isSet()) {
                            return;
                        }
                    } else {
                        await sleep(delay);
                    }
                    console.info("Resuming after throttle period");
                    continue;
                } else {
                    throw e;
                }
            }
        }
    }


    async function syncData(athlete, options={}) {
        const athleteId = athlete.get('id');
        const fetchedIds = new Set(await actsStore.getForAthleteWithSyncLatest(athleteId,
            'streams', {keys: true}));
        const noStreamIds = new Set(await actsStore.getForAthleteWithSyncVersion(athleteId,
            'streams', -Infinity, {keys: true}));
        const localIds = new Set(await actsStore.getForAthleteWithSyncLatest(athleteId,
            'local', {keys: true}));
        const unfetched = new Map();
        const unprocessed = new Set();
        const activities = new Map();
        for (const id of await actsStore.getAllForAthlete(athlete.get('id'), {keys: true})) {
            if (!noStreamIds.has(id)) {
                if (!fetchedIds.has(id)) {
                    unfetched.set(id, null);
                    activities.set(id, null);
                } else if (!localIds.has(id)) {
                    unprocessed.add(id);
                    activities.set(id, null);
                }
            }
        }
        for (const a of await actsStore.getMany(Array.from(activities.keys()), {models: true})) {
            activities.set(a.get('id'), a);
        }
        const procQueue = new queues.Queue();
        // After getting all our raw data we need to check that we can sync based on error backoff...
        for (const id of unfetched.keys()) {
            const a = activities.get(id);
            if (!a.nextSync('streams')) {
                console.info(`Deferring streams fetch of ${id} due to recent error`);
                unfetched.delete(id);
            } else {
                unfetched.set(id, a);
            }
        }
        for (const id of unprocessed) {
            const a = activities.get(id);
            if (!a.nextSync('local')) {
                console.info(`Deferring local processing of ${id} due to error`);
            } else {
                procQueue.putNoWait(a);
            }
        }
        const workers = [];
        if (unfetched.size) {
            workers.push(fetchStreamsWorker(procQueue, [...unfetched.values()], athlete, options));
        } else if (!procQueue.qsize()) {
            console.debug("No activity sync required for: " + athlete);
            return;
        } else {
            procQueue.putNoWait(null);  // sentinel
        }
        workers.push(localProcessWorker(procQueue, athlete, options));
        await Promise.all(workers);
        console.debug("Activity sync completed for: " + athlete);
    }


    async function fetchStreamsWorker(procQueue, ...args) {
        try {
            return await _fetchStreamsWorker(procQueue, ...args);
        } finally {
            procQueue.putNoWait(null);
        }
    }


    async function _fetchStreamsWorker(procQueue, activities, athlete, options={}) {
        const cancelEvent = options.cancelEvent;
        for (const activity of activities) {
            let error;
            let data;
            try {
                data = await fetchStreams(activity, {cancelEvent});
            } catch(e) {
                console.warn("Fetch streams error (will retry later):", e);
                error = e;
            }
            if (cancelEvent.isSet()) {
                console.info('Sync streams cancelled');
                return;
            }
            if (data) {
                await streamsStore.putMany(Object.entries(data).map(([stream, data]) => ({
                    activity: activity.get('id'),
                    athlete: athlete.get('id'),
                    stream,
                    data
                })));
                activity.setSyncVersionLatest('streams');
                procQueue.putNoWait(activity);
            } else if (data === null) {
                activity.setSyncVersion('streams', -Infinity);
            } else if (error) {
                // Often this is an activity converted to private.
                activity.setSyncError('streams', error);
            }
            await activity.save();
            if (options.onStreams) {
                await options.onStreams({activity, data, error});
            }
        }
        console.info("Completed streams fetch for: " + athlete);
    }


    async function localProcessWorker(q, athlete, options={}) {
        const cancelEvent = options.cancelEvent;
        let done = false;
        const complete = new Set();
        const incomplete = new Set();
        while (!done && !cancelEvent.isSet()) {
            const batch = new Set();
            while (q.qsize()) {
                const a = q.getNoWait();
                if (a === null) {
                    done = true;
                    break;
                }
                batch.add(a);
                if (batch.size >= 1000) {
                    break;
                }
            }
            if (!batch.size && !done) {
                // For handling single items coming off the streams fetch worker...
                const a = await Promise.race([q.get(), cancelEvent.wait()]);
                if (a === null) {
                    done = true;
                } else if (!cancelEvent.isSet()) {
                    batch.add(a);
                }
            }
            while (batch.size && !cancelEvent.isSet()) {
                const versionedBatches = new Map();
                for (const a of batch) {
                    const m = a.nextSync('local');
                    if (!m) {
                        if (!a.isSyncLatest('local')) {
                            console.info(`Deferring local processing of ${a} due to recent error`);
                            incomplete.add(a);
                        } else {
                            complete.add(a);
                        }
                        batch.delete(a);
                        continue;
                    }
                    if (!versionedBatches.has(m)) {
                        versionedBatches.set(m, new Set());
                    }
                    versionedBatches.get(m).add(a);
                }
                for (const [m, activities] of versionedBatches.entries()) {
                    const s = Date.now();
                    const fn = m.data;
                    for (const a of activities) {
                        a.clearSyncError('local');
                    }
                    try {
                        console.debug(`Local processing (${fn.name}) v${m.version} on ${activities.size} activities`);
                        await fn({activities, athlete});
                    } catch(e) {
                        console.warn("Top level local processing error:", fn.name, m.version, e);
                        for (const a of activities) {
                            a.setSyncError('local', e);
                        }
                    }
                    for (const a of activities) {
                        if (!a.hasSyncError('local')) {
                            a.setSyncVersion('local', m.version);
                        }
                    }
                    await actsStore.saveModels(activities);
                    const elapsed = Date.now() - s;
                    const count = activities.size;
                    console.info(`${fn.name} ${Math.round(elapsed / count)}ms / activity, ${count} activities`);
                }
            }
            if (complete.size + incomplete.size && options.onLocalProcessing) {
                await options.onLocalProcessing({complete, incomplete, athlete});
            }
        }
    }


    class WorkerPoolExecutor {
        constructor(url, options={}) {
            this.url = url;
            this.maxWorkers = options.maxWorkers || (navigator.hardwareConcurrency * 2);
            this._idle = new queues.Queue();
            this._busy = new Set();
            this._id = 0;
        }

        async _getWorker() {
            let worker;
            if (!this._idle.qsize()) {
                if (this._busy.size >= this.maxWorkers) {
                    console.warn("Waiting for available worker...");
                    worker = await this._idle.get();
                } else {
                    worker = new Worker(this.url);
                }
            } else {
                worker = await this._idle.get();
            }
            if (worker.dead) {
                return await this._getWorker();
            }
            if (worker.gcTimeout) {
                clearTimeout(worker.gcTimeout);
            }
            this._busy.add(worker);
            return worker;
        }

        async exec(call, ...args) {
            const id = this._id++;
            const f = new futures.Future();
            const onMessage = ev => {
                if (!ev.data || ev.data.id == null) {
                    f.setError(new Error("Invalid Worker Message"));
                } else if (ev.data.id !== id) {
                    console.warn('Ignoring worker message from other job');
                    return;
                } else {
                    if (ev.data.success) {
                        f.setResult(ev.data.value);
                    } else {
                        f.setError(ev.data.value);
                    }
                }
            };
            const worker = await this._getWorker();
            worker.addEventListener('message', onMessage);
            try {
                worker.postMessage({call, args, id});
                return await f;
            } finally {
                worker.removeEventListener('message', onMessage);
                this._busy.delete(worker);
                worker.gcTimeout = setTimeout(() => {
                    worker.dead = true;
                    worker.terminate();
                }, 30000);
                this._idle.put(worker);
            }
        }
    }

    const workerPool = new WorkerPoolExecutor(extUrl + 'src/bg/hist-worker.js');


    async function findPeaks(...args) {
        const s = Date.now();
        const result = await workerPool.exec('findPeaks', ...args);
        console.debug('Done: took', Date.now() - s);
        return result;
    }
    sauce.proxy.export(findPeaks, {namespace});


    async function bulkTSS(...args) {
        const s = Date.now();
        const result = await workerPool.exec('bulkTSS', ...args);
        console.debug('Done: took', Date.now() - s);
        return result;
    }
    sauce.proxy.export(bulkTSS, {namespace});


    function download(blob, name) {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = name;
        link.style.display = 'none';
        document.body.appendChild(link);
        try {
            link.click();
        } finally {
            link.remove();
            URL.revokeObjectURL(link.href);
        }
    }


    async function exportStreams(name, athlete) {
        name = name || 'streams-export';
        const entriesPerFile = 5000;  // Blob and JSON.stringify have arbitrary limits.
        const batch = [];
        let page = 0;
        function dl(data) {
            const blob = new Blob([JSON.stringify(data)]);
            download(blob, `${name}-${page++}.json`);
        }
        const iter = athlete ? streamsStore.byAthlete(athlete) : streamsStore.values();
        for await (const x of iter) {
            batch.push(x);
            if (batch.length === entriesPerFile) {
                dl(batch);
                batch.length = 0;
            }
        }
        if (batch.length) {
            dl(batch);
        }
        console.info("Export done");
    }
    sauce.proxy.export(exportStreams, {namespace});


    async function importStreams(name='streams-export', host='http://localhost:8001') {
        let added = 0;
        for (let i = 0;; i++) {
            const url = host + `/${name}-${i}.json`;
            const resp = await fetch(url);
            if (!resp.ok) {
                if (resp.status === 404) {
                    break;
                }
                throw new Error('HTTP Error: ' + resp.status);
            }
            const data = await resp.json();
            added += data.length;
            await streamsStore.putMany(data);
            console.info(`Imported ${data.length} from:`, url);
        }
        console.info(`Imported ${added} entries in total.`);
    }
    sauce.proxy.export(importStreams, {namespace});


    // XXX maybe move to analysis page until we figure out the strategy for all
    // historical data.
    async function getSelfFTPHistory() {
        const resp = await fetch("https://www.strava.com/settings/performance");
        const raw = await resp.text();
        const table = [];
        if (raw) {
            const encoded = raw.match(/all_ftps = (\[.*\]);/);
            if (encoded) {
                for (const x of JSON.parse(encoded[1])) {
                    table.push({ts: x.start_date * 1000, value: x.value});
                }
            }
        }
        return table;
    }
    sauce.proxy.export(getSelfFTPHistory, {namespace});


    async function addAthlete({id, ...data}) {
        if (!id || !data.gender || !data.name) {
            throw new TypeError('id, gender and name values are required');
        }
        const athlete = await athletesStore.get(id, {model: true});
        if (athlete) {
            await athlete.save(data);
        } else {
            await athletesStore.put({id, ...data});
        }
    }
    sauce.proxy.export(addAthlete, {namespace});


    async function getAthlete(id) {
        return await athletesStore.get(id);
    }
    sauce.proxy.export(getAthlete, {namespace});


    async function enableAthlete(id) {
        if (!id) {
            throw new TypeError('id is required');
        }
        if (!ns.syncManager) {
            throw new Error("Sync Manager is not available");
        }
        await ns.syncManager.enableAthlete(id);
    }
    sauce.proxy.export(enableAthlete, {namespace});


    async function disableAthlete(id) {
        if (!id) {
            throw new TypeError('id is required');
        }
        if (!ns.syncManager) {
            throw new Error("Sync Manager is not available");
        }
        await ns.syncManager.disableAthlete(id);
    }
    sauce.proxy.export(disableAthlete, {namespace});


    async function invalidateSyncState(athleteId, name) {
        if (!athleteId || !name) {
            throw new TypeError('athleteId and name are required args');
        }
        const activities = await actsStore.getAllForAthlete(athleteId);
        for (const a of activities) {
            if (a.syncState) {
                delete a.syncState[name];
            }
        }
        await actsStore.updateMany(activities.map(x => ({id: x.id, syncState: x.syncState})));
        if (ns.syncManager) {
            await ns.syncManager.enableAthlete(athleteId); // Reset sync state
        }
        return activities.length;
    }


    class SyncJob extends EventTarget {
        constructor(athlete, isSelf) {
            super();
            this.athlete = athlete;
            this.isSelf = isSelf;
            this.status = 'init';
            this._cancelEvent = new locks.Event();
        }

        run() {
            this._runPromise = this._run();
        }

        async wait() {
            await this._runPromise;
        }

        cancel() {
            this._cancelEvent.set();
        }

        cancelled() {
            return this._cancelEvent.isSet();
        }

        async _run() {
            this.status = 'activities-scan';
            const syncFn = this.isSelf ? ns.syncSelfActivities : ns.syncPeerActivities;
            await syncFn(this.athlete.get('id'));
            this.status = 'streams-sync';
            try {
                await syncData(this.athlete, {
                    cancelEvent: this._cancelEvent,
                    onStreams: this._onStreams.bind(this),
                    onLocalProcessing: this._onLocalProcessing.bind(this),
                });
            } catch(e) {
                this.status = 'error';
                throw e;
            }
            this.status = 'complete';
        }

        _onStreams(data) {
            const ev = new Event('streams');
            ev.data = data;
            this.dispatchEvent(ev);
        }

        _onLocalProcessing(data) {
            const ev = new Event('local');
            ev.data = data;
            this.dispatchEvent(ev);
        }
    }


    class SyncManager extends EventTarget {
        constructor(currentUser) {
            super();
            console.info(`Starting Sync Manager for:`, currentUser);
            //this.refreshInterval = 12 * 3600 * 1000;  // Or shorter with user intervention
            this.refreshInterval = 120 * 1000;  // XXX
            //this.refreshErrorBackoff = 1 * 3600 * 1000;
            this.refreshErrorBackoff = 60 * 1000; // XXX
            this.currentUser = currentUser;
            this.activeJobs = new Map();
            this._stopping = false;
            this._athleteLock = new locks.Lock();
            this._refreshRequests = new Set();
            this._refreshEvent = new locks.Event();
            this._refreshLoop = this.refreshLoop();
        }

        stop() {
            this._stopping = true;
            for (const x of this.activeJobs.values()) {
                x.cancel();
            }
            this._refreshEvent.set();
        }

        async join() {
            await Promise.allSettled(Array.from(this.activeJobs.values()).map(x => x.wait()));
            await this._refreshLoop;
        }

        async refreshLoop() {
            let errorBackoff = 1000;
            while (!this._stopping) {
                try {
                    await this._refresh();
                } catch(e) {
                    console.error('SyncManager refresh error:', e);
                    sauce.report.error(e);
                    await sleep(errorBackoff *= 1.5);
                }
                this._refreshEvent.clear();
                const enabledAthletes = await athletesStore.getEnabledAthletes({models: true});
                if (!enabledAthletes.length) {
                    console.debug('No athletes enabled for sync.');
                    await this._refreshEvent.wait();
                } else {
                    let oldest = -1;
                    const now = Date.now();
                    for (const athlete of enabledAthletes) {
                        if (this.isActive(athlete) || this._isDeferred(athlete)) {
                            continue;
                        }
                        const age = now - athlete.get('lastSync');
                        oldest = Math.max(age, oldest);
                    }
                    if (oldest === -1) {
                        await this._refreshEvent.wait();
                    } else {
                        const deadline = this.refreshInterval - oldest;
                        console.debug(`Next Sync Manager refresh in ${Math.round(deadline / 1000)} seconds`);
                        await Promise.race([sleep(deadline), this._refreshEvent.wait()]);
                    }
                }
            }
        }

        async _refresh() {
            for (const athlete of await athletesStore.getEnabledAthletes({models: true})) {
                if (this.isActive(athlete)) {
                    continue;
                }
                const now = Date.now();
                if ((now - athlete.get('lastSync') > this.refreshInterval && !this._isDeferred(athlete)) ||
                    this._refreshRequests.has(athlete.get('id'))) {
                    this._refreshRequests.delete(athlete.get('id'));
                    this.runSyncJob(athlete);  // bg okay
                }
            }
        }

        isActive(athlete) {
            return this.activeJobs.has(athlete.get('id'));
        }

        _isDeferred(athlete) {
            const lastError = athlete.get('lastError');
            return !!lastError && Date.now() - lastError < this.refreshErrorBackoff;
        }

        async runSyncJob(athlete) {
            const start = Date.now();
            console.debug('Starting sync job for: ' + athlete);
            const athleteId = athlete.get('id');
            const isSelf = this.currentUser === athleteId;
            const syncJob = new SyncJob(athlete, isSelf);
            syncJob.addEventListener('streams', ev => {
                // We try to recover from errors, so just hide them from the user for now.
                if (!ev.data.error) {
                    this.emitForAthlete(athlete, 'progress', {
                        sync: 'streams',
                        activity: ev.data.activity.get('id')
                    });
                }
            });
            syncJob.addEventListener('local', ev => {
                if (ev.data.complete.size) {
                    this.emitForAthlete(athlete, 'progress', {
                        sync: 'local',
                        activities: Array.from(ev.data.complete).map(x => x.get('id'))
                    });
                }
            });
            this.emitForAthlete(athlete, 'start');
            this.activeJobs.set(athleteId, syncJob);
            syncJob.run();
            try {
                await syncJob.wait();
            } catch(e) {
                console.error('Sync error occurred:', e);
                athlete.set('lastError', Date.now());
                this.emitForAthlete(athlete, 'error', syncJob.status);
            } finally {
                athlete.set('lastSync', Date.now());
                await this._athleteLock.acquire();
                try {
                    await athlete.save();
                } finally {
                    this._athleteLock.release();
                }
                this.activeJobs.delete(athleteId);
                this._refreshEvent.set();
                this.emitForAthlete(athlete, 'stop', syncJob.status);
                console.debug(`Sync completed in ${Date.now() - start}ms for: ` + athlete);
            }
        }

        emitForAthlete(athlete, ...args) {
            return this.emitForAthleteId(athlete.get('id'), ...args);
        }

        emitForAthleteId(athleteId, name, data) {
            const ev = new Event(name);
            ev.athlete = athleteId,
            ev.data = data;
            this.dispatchEvent(ev);
        }

        refreshRequest(athleteId) {
            this._refreshRequests.add(athleteId);
            this._refreshEvent.set();
        }

        async updateAthlete(id, obj) {
            await this._athleteLock.acquire();
            try {
                const athlete = await athletesStore.get(id, {model: true});
                if (!athlete) {
                    throw new Error('Athlete not found: ' + id);
                }
                await athlete.save(obj);
            } finally {
                this._athleteLock.release();
            }
        }

        async enableAthlete(id) {
            await this.updateAthlete(id, {sync: DBTrue, lastSync: 0, lastError: 0, syncStatus: 'new'});
            this._refreshEvent.set();
            this.emitForAthleteId(id, 'enable');
        }

        async disableAthlete(id) {
            await this.updateAthlete(id, {sync: DBFalse});
            if (this.activeJobs.has(id)) {
                const syncJob = this.activeJobs.get(id);
                syncJob.cancel();
            }
            this._refreshEvent.set();
            this.emitForAthleteId(id, 'disable');
        }

        async purgeAthleteData(athlete) {
            // Obviously use with extreme caution!
            await actsStore.deleteAthlete(athlete);
        }

    }

    if (self.currentUser) {
        ns.syncManager = new SyncManager(self.currentUser);
    }
    addEventListener('currentUserUpdate', async ev => {
        if (ns.syncManager && ns.syncManager.currentUser !== ev.id) {
            console.warn("Stopping Sync Manager due to user change...");
            ns.syncManager.stop();
            await ns.syncManager.join();
            console.debug("Sync Manager stopped.");
        }
        ns.syncManager = ev.id ? new SyncManager(ev.id) : null;
    });


    class SyncController extends sauce.proxy.Eventing {
        constructor(athleteId) {
            super();
            this.athleteId = athleteId;
            this._syncListeners = [];
            this._setupEventRelay('start');
            this._setupEventRelay('stop');
            this._setupEventRelay('progress');
            this._setupEventRelay('enable');
            this._setupEventRelay('disable');
        }

        delete() {
            for (const [name, listener] of this._syncListeners) {
                const sm = ns.syncManager;
                if (sm) {
                    sm.removeEventListener(name, listener);
                }
            }
            this._syncListeners.length = 0;
        }

        _setupEventRelay(name) {
            const listener = ev => {
                if (ev.athlete === this.athleteId) {
                    this.dispatchEvent(ev);
                }
            };
            ns.syncManager.addEventListener(name, listener);
            this._syncListeners.push([name, listener]);
        }

        isActive() {
            return !!(ns.syncManager && ns.syncManager.activeJobs.has(this.athleteId));
        }

        async start() {
            if (!ns.syncManager) {
                throw new Error("Sync Manager is not available");
            }
            await ns.syncManager.enableAthlete(this. athleteId);
        }

        async cancel() {
            if (ns.syncManager) {
                const job = ns.syncManager.activeJobs.get(this.athleteId);
                if (job) {
                    job.cancel();
                    await job.wait();
                    return true;
                }
            }
        }

        async invalidate(name) {
            if (!ns.syncManager) {
                throw new Error("Sync Manager is not available");
            }
            await invalidateSyncState(this.athleteId, name);
        }

        rateLimiterResumes() {
            const g = streamRateLimiterGroup;
            if (g && g.sleeping()) {
                return streamRateLimiterGroup.resumes();
            }
        }

        rateLimiterSleeping() {
            const g = streamRateLimiterGroup;
            return g & g.sleeping();
        }

        async activitiesCount() {
            return await actsStore.countForAthlete(this.athleteId);
        }

        async activitiesSynced() {
            const noStreamIds = new Set(await actsStore.getForAthleteWithSyncVersion(this.athleteId,
                'streams', -Infinity, {keys: true}));
            const localIds = new Set(await actsStore.getForAthleteWithSyncLatest(this.athleteId,
                'local', {keys: true}));
            const unsynced = new Set();
            let total = 0;
            for (const id of await actsStore.getAllForAthlete(this.athleteId, {keys: true})) {
                total++;
                if (!noStreamIds.has(id) && !localIds.has(id)) {
                    unsynced.add(id);
                }
            }
            for (const a of await actsStore.getMany(Array.from(unsynced), {models: true})) {
                if (!a.nextSync('local')) {
                    // count it it's latest or can't be synced due to error. Some
                    // activities may never recover from some error state, so just
                    // count them as being done.
                    unsynced.delete(a.get('id'));
                }
            }
            return total - unsynced.size;
        }

        async lastSync() {
            return (await athletesStore.get(this.athleteId)).lastSync;
        }

        async nextSync() {
            return ns.syncManager.refreshInterval + await this.lastSync();
        }
    }
    sauce.proxy.export(SyncController, {namespace});


    return {
        importStreams,
        exportStreams,
        syncSelfActivities,
        syncPeerActivities,
        syncData,
        invalidateSyncState,
        findPeaks,
        bulkTSS,
        streamsStore,
        actsStore,
        athletesStore,
        SyncManager,
        SyncController,
    };
}, {hasAsyncExports: true});
