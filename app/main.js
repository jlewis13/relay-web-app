// vim: ts=4:sw=4:expandtab
/* global Backbone */

(function() {
    'use strict';

    let $loadingDimmer;
    let $loadingProgress;
    const progressSteps = 3;

    const logger = F.log.getLogger('main');

    let _lastTick;
    function loadingTick(titleChange, amount) {
        if (_lastTick) {
            const lastTitle = $loadingDimmer.find('.loader.text').text();
            logger.debug(`"${lastTitle}" took: ${Date.now() - _lastTick}ms`);
        }
        _lastTick = Date.now();
        if (titleChange) {
            $loadingDimmer.find('.loader.text').html(titleChange);
        }
        if (amount === 0) {
            return;
        }
        const pval = $loadingProgress.progress('get value');
        if (amount + pval > progressSteps) {
            logger.warn("Loading progress ceiling is lower than:", pval + amount);
        }
        $loadingProgress.progress('increment', amount);
    }

    async function loadFoundation() {
        const registered = await F.state.get('registered');
        if (!registered) {
            await F.foundation.initRelay();
            const devices = await F.atlas.getDevices();
            const provisionView = new F.ProvisionView({devices});
            await provisionView.show();
            await provisionView.finished;
        }
        await F.foundation.initApp();
    }

    async function checkPreMessages() {
        const preMessageSenders = await F.state.get('instigators');
        if (preMessageSenders && preMessageSenders.length) {
            for (const contact of await F.atlas.getContacts(preMessageSenders)) {
                if (!contact) {
                    logger.error("Skiping invalid pre message sender");
                    continue;
                }
                logger.warn("Sending pre-message check to:", contact.getTagSlug());
                const t = new F.Thread({
                    id: F.util.uuid4(),
                    distribution: contact.getTagSlug()
                }, {deferSetup: true});
                await t.sendControl({control: 'preMessageCheck'});
            }
            await F.state.put('instigators', null);
        }
    }

    async function checkInterruptedCalls() {
        if (F.calling.getManagers().length) {
            // Just skip all this if we are already in a call.  This commonly happens when the
            // URL used to load the site asked for a call to start immediately.
            return;
        }
        const activeCalls = F.foundation.allThreads.filter(m => m.get('callJoined'));
        await Promise.all(activeCalls.map(x => x.save({callJoined: false})));
        activeCalls.sort((a, b) => a.get('callActive') < b.get('callActive') ? 1 : -1);
        const mostRecent = activeCalls[0];
        if (mostRecent && mostRecent.get('callActive') > Date.now() - 300000) {
            const rejoin = await F.util.confirmModal({
                header: 'Rejoin interrupted call?',
                content: `Would you like to rejoin your call with:
                          ${mostRecent.getNormalizedTitle()}?`
            });
            const callMgr = F.calling.getOrCreateManager(mostRecent.id, mostRecent);
            if (rejoin) {
                // XXX Fix modal dimmer handling (e.g. make call view not a modal
                F.sleep(1).then(() => callMgr.start({autoJoin: true}));
            } else {
                await callMgr.sendLeave();
            }
        }
    }

    async function initTheme() {
        F.util.chooseTheme(await F.state.get('theme', 'default'));
    }

    const preloaded = (async () => {
        await F.util.validateBrowser();
        await Backbone.initDatabase(F.SharedCacheDatabase);
    })();

    async function main() {
        await preloaded;
        logger.info(`<large><b><sans>Starting Forsta Messenger:</sans></b> v${F.version}</large>`);

        $loadingDimmer = $('.f-loading.ui.dimmer');
        $loadingProgress = $loadingDimmer.find('.ui.progress');
        $loadingProgress.progress({total: progressSteps});

        loadingTick('Checking authentication...');
        await F.atlas.login();

        await Promise.all([
            F.util.startIssueReporting(),
            F.util.startUsageReporting(),
            F.tpl.loadPartials(),
            loadFoundation(),
            initTheme(),
        ]);

        if ('serviceWorker' in navigator) {
            F.serviceWorkerManager = new F.ServiceWorkerManager();
            F.serviceWorkerManager.start(); // bg okay
        }

        loadingTick('Loading conversations...');
        F.mainView = new F.MainView();
        await F.mainView.render();
        loadingTick();

        $loadingDimmer.removeClass('active');

        // Regression check of progress bar ticks.   The numbers need to managed manually.
        const pval = $loadingProgress.progress('get value');
        if (pval / progressSteps < 0.90) {
            logger.warn("Progress bar never reached 90%", pval);
        }

        const haveRoute = F.router.start();
        if (!haveRoute && !F.util.isSmallScreen()) {
            await F.mainView.openMostRecentThread();
        } else {
            await F.mainView.openedThread;
        }

        logger.info(`Messenger load time: ${Math.round(performance.now())}ms`);
        if (F.parentRPC) {
            F.parentRPC.triggerEvent('loaded');
        }

        const msgRecv = F.foundation.getMessageReceiver();
        await msgRecv.idle;  // Let things cool out..
        logger.info('Message receiver reached idle state.');

        await checkPreMessages();
        await checkInterruptedCalls();

        const lastSync = (await F.state.get('lastSync')) || 0;
        if (lastSync < Date.now() - (86400 * 5 * 1000)) {
            await F.util.syncContentHistory({silent: lastSync !== 0});
            (new F.sync.Request()).syncDeviceInfo();
        }
        F.sleep(86400 * Math.random()).then(() => (new F.sync.Request()).syncDeviceInfo());
    }

    addEventListener('load', main);
}());
