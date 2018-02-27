// vim: ts=4:sw=4:expandtab
/* global relay, platform */

/*
 * Sync engine that handles comparing our data with our other devices so we can
 * stay in sync.  Mostly for onboarding new devices.
 */

(function() {
    'use strict';

    self.F = self.F || {};
    const ns = F.sync = {};

    class Request extends F.AsyncEventTarget {

        constructor() {
            super();
            this.syncThread = new F.Thread({}, {deferSetup: true});
            this.id = this.syncThread.id;
            this.stats = {
                messages: 0,
                threads: 0,
                contacts: 0
            };
            this._messageCollections = new Map();
        }

        async start(type, data, options) {
            options = options || {};
            const ttl = options.ttl || 60000;
            let devices = options.devices;
            if (!devices) {
                const tooOld = Date.now() - (86400 * 3 * 1000);
                let fullDevices = await F.atlas.getDevices();
                fullDevices = fullDevices.filter(x => x.id !== F.currentDevice && x.lastSeen > tooOld);
                fullDevices.sort((a, b) => a.created - b.created);
                devices = fullDevices.map(x => x.id);
            }
            if (!devices.length) {
                console.warn("No devices to sync with!");
                return;
            }
            console.info(`Starting sync request [${type}] with:`, devices, this.id);
            await this.syncThread.sendSyncControl(Object.assign({
                control: 'syncRequest',
                devices,
                ttl,
                type
            }, data));
        }

        _bindEventListener(listener) {
            // TODO: cleanup listener when "done".
            if (this._bound) {
                throw new Error("Request cannot be reused");
            }
            this._bound = true;
            addEventListener('syncResponse', ev => {
                if (ev.id !== this.id) {
                    console.debug("Dropping sync response from foreign session:", ev.id);
                    return;
                }
                F.queueAsync('sync:' + this.id, () => listener(ev));
            });
        }

        async syncContentHistory(options) {
            /* Collect our own content into a manifest that acts as an exclude
             * list to the responders. */
            const knownMessages = [];
            const knownThreads = [];
            const knownContacts = F.foundation.getContacts().map(x => x.id);
            for (const thread of F.foundation.allThreads.models) {
                const mc = new F.MessageCollection([], {thread});
                await mc.fetchAll();
                for (const m of mc.models) {
                    knownMessages.push(m.id);
                }
                knownThreads.push({
                    id: thread.id,
                    lastActivity: thread.get('timestamp')
                });
            }
            this._bindEventListener(this.onContentHistoryResponse.bind(this));
            await this.start('contentHistory', {
                knownMessages,
                knownThreads,
                knownContacts
            }, options);
        }

        async syncDeviceInfo(options) {
            this._bindEventListener(this.onDeviceInfoResponse.bind(this));
            await this.start('deviceInfo');
        }

        async onContentHistoryResponse(ev) {
            const response = ev.data.exchange.data;
            const allAttachments = ev.data.attachments;
            const candidates = {
                threads: response.threads || [],
                messages: response.messages || [],
                contacts: response.contacts || []
            };
            const senderDevice = ev.data.message.get('senderDevice');
            console.info(`Handling content history sync response from ${senderDevice}: ` +
                         `${candidates.threads.length} threads, ` +
                         `${candidates.messages.length} messages, ` +
                         `${candidates.contacts.length} contacts.`);
            for (const t of candidates.threads) {
                const existing = F.foundation.allThreads.get(t.id);
                if (!existing || existing.get('timestamp') < t.timestamp) {
                    await F.foundation.allThreads.add(t).save();
                    this.stats.threads++;
                }
            }
            for (const m of candidates.messages) {
                if (!this._messageCollections.has(m.threadId)) {
                    const mc = new F.MessageCollection([], {threadId: m.threadId});
                    await mc.fetchAll();
                    this._messageCollections.set(m.threadId, mc);
                }
                const mCol = this._messageCollections.get(m.threadId);
                if (!mCol.get(m.id)) {
                    if (m.attachments.length) {
                        for (const x of m.attachments) {
                            x.data = allAttachments[x.index].data;
                            delete x.index;
                        }
                    }
                    await mCol.add(m).save();
                    this.stats.messages++;
                }
            }
            const ourContacts = F.foundation.getContacts();
            const newContacts = [];
            for (const c of candidates.contacts) {
                if (!ourContacts.get(c)) {
                    newContacts.push(c);
                }
            }
            await F.atlas.getContacts(newContacts);
            this.stats.contacts += newContacts.length;
            await this._dispatchResponseEvent(response);
        }

        async onDeviceInfoResponse(ev) {
            /* Merge in new data into our `ourDevices` state. */
            const deviceInfo = ev.data.exchange.data.deviceInfo;
            const ourDevices = (await F.state.get('ourDevices')) || new Map();
            const existing = ourDevices.get(deviceInfo.id);
            ourDevices.set(deviceInfo.id, Object.assign(existing || {}, deviceInfo));
            await F.state.put('ourDevices', ourDevices);
            await this._dispatchResponseEvent(ev.data.exchange.data);
        }

        async _dispatchResponseEvent(data) {
            const ev = new Event('response');
            ev.request = this;
            ev.data = data;
            await this.dispatchEvent(ev);
        }
    }
    ns.Request = Request;


    class Responder {

        constructor(id, senderDevice) {
            this.id = id;
            this.senderDevice = senderDevice;
            this.senderThread = new F.Thread({id}, {deferSetup: true});
        }

        async sendResponse(data, attachments) {
            return await this.senderThread.sendSyncControl(Object.assign({
                control: 'syncResponse',
                device: this.senderDevice
            }, data), attachments);
        }

        async process(request) {
            throw new Error('Virtual Method Not Implemented');
        }
    }


    class ContentHistoryResponder extends Responder {

        async process(request) {
            this.theirContacts = new Set(request.knownContacts);
            this.theirThreads = new Map(request.knownThreads.map(x => [x.id, x.lastActivity]));
            this.theirMessages = new Set(request.knownMessages);
            const onPeerResponse = this.onPeerResponse.bind(this);
            addEventListener('syncResponse', onPeerResponse);
            try {
                /* Stagger our start based on our location in the request's devices
                 * array.  Our position indicates our priority and we should allow
                 * devices in front of us opportunity to fulfill the request first. */
                const delay = request.devices.indexOf(F.currentDevice) * 15;
                if (delay) {
                    console.info("Delay sync-request response for:", delay);
                    await relay.util.sleep(delay);
                }
                await this._process(request);
            } finally {
                removeEventListener('syncResponse', onPeerResponse);
            }
        }

        async _process(request) {
            console.info("Starting sync-request response:", this.id);
            const contactsDiff = F.foundation.getContacts().filter(c =>
                !this.theirContacts.has(c.id));
            const stats = {
                contacts: contactsDiff.length,
                threads: 0,
                messages: 0
            };
            if (contactsDiff.length) {
                await this.sendContacts(contactsDiff);
            }
            /* By shuffling threads and messages we partner better with other peers
             * sending data.  This allows the requester to process results from
             * multiple clients more effectively.  It also adds eventual consistency
             * in the case of a thread/msg that wedges the process every time. */
            for (const thread of F.foundation.allThreads.shuffle()) {
                const messages = new F.MessageCollection([], {thread});
                await messages.fetchAll();
                const messagesDiff = messages.shuffle().filter(m =>
                    !this.theirMessages.has(m.id));
                stats.messages += messagesDiff.length;
                while (messagesDiff.length) {
                    await this.sendMessages(messagesDiff.splice(0, 100));
                }
                const ts = this.theirThreads.get(thread.id);
                if (!ts || ts < new Date(thread.get('timestamp'))) {
                    stats.threads++;
                    await this.sendThreads([thread]);
                }
            }
            console.info(`Fulfilled sync request for device ${this.senderDevice}: ` +
                         `${stats.threads} threads, ${stats.messages} messages, ` +
                         `${stats.contacts} contacts.`, this.id);
        }

        onPeerResponse(ev) {
            /* Monitor the activity of other responders. We can mark off data sent by our
             * peers to avoid repeat sends of the same data. */
            if (ev.id !== this.id) {
                console.debug("Dropping sync response from foreign session:", ev.id);
                return;
            }
            const peerResponse = ev.data.exchange.data;
            for (const t of (peerResponse.threads || [])) {
                console.debug("Learned about thread:", t);
                this.theirThreads.set(t.id, (new Date(t.timestamp)).toJSON());
            }
            for (const m of (peerResponse.messages || [])) {
                console.debug("Learned about message:", m);
                this.theirMessages.add(m.id);
            }
            for (const c of (peerResponse.contacts || [])) {
                console.debug("Learned about contact:", c);
                this.theirContacts.add(c);
            }
        }

        async sendMessages(messages) {
            console.info(`Synchronizing ${messages.length} messages with device:`,
                         this.senderDevice);
            const allAttachments = [];
            await this.sendResponse({
                messages: messages.map(model => {
                    const m = model.attributes;
                    const attachments = [];
                    if (m.attachments) {
                        for (const x of m.attachments) {
                            const index = allAttachments.push(x) - 1;
                            const proxy = Object.assign({index}, x);
                            delete proxy.data;
                            attachments.push(proxy);
                        }
                    }
                    return {
                        attachments,
                        expiration: m.expiration,
                        html: m.safe_html,
                        id: m.id,
                        members: m.members,
                        monitors: m.monitors,
                        pendingMembers: m.pendingMembers,
                        plain: m.plain,
                        received: m.received,
                        sender: m.sender,
                        senderDevice: m.senderDevice,
                        sent: m.sent,
                        threadId: m.threadId,
                        type: m.type,
                        userAgent: m.userAgent,
                    };
                })
            }, allAttachments);
        }

        async sendThreads(threads) {
            console.info(`Synchronizing ${threads.length} threads with device:`,
                         this.senderDevice);
            await this.sendResponse({
                threads: threads.map(thread => {
                    const t = thread.attributes;
                    return {
                        distribution: t.distribution,
                        id: t.id,
                        lastMessage: t.lastMessage,
                        left: t.left,
                        pendingMembers: t.pendingMembers,
                        pinned: t.pinned,
                        position: t.postion,
                        sender: t.sender,
                        started: t.started,
                        timestamp: t.timestamp,
                        type: t.type,
                        unreadCount: t.unreadCount,
                    };
                })
            });
        }

        async sendContacts(contacts) {
            console.info(`Synchronizing ${contacts.length} contacts with device:`,
                         this.senderDevice);
            await this.sendResponse({contacts: contacts.map(contact => contact.id)});
        }
    }


    class DeviceInfoResponder extends Responder {

        async process(request) {
            const conn = navigator.connection || {};
            const connectionType = conn.type || conn.effectiveType;
            const deviceInfo = {
                id: F.currentDevice,
                lastLocation: await this.getLocation(),
                userAgent: F.userAgent,
                platform: platform.toString(),
                version: F.version,
                name: await F.state.get('name'),
                lastSync: await F.state.get('lastSync'),
                connectionType,
                lastIP: F.env.CLIENT_IP
            };
            await this.sendResponse({deviceInfo});
        }

        async getLocation() {
            // XXX Make this out of band and cached to our own storage as a "last known location"
            if (!navigator.geolocation) {
                console.warn("Geo Location not supported");
                return;
            }
            try {
                const curPos = new Promise((resolve, reject) =>
                    navigator.geolocation.getCurrentPosition(pos => resolve({
                        latitude: pos.coords.latitude,
                        longitude: pos.coords.longitude,
                        accuracy: pos.coords.accuracy
                    }), reject));
                return await Promise.race([relay.util.sleep(30).then(() => undefined), curPos]);
            } catch(e) {
                console.warn("Ignore geolocation error:", e);
            }
        }
    }

    ns.processRequest = async function(ev) {
        const message = ev.data.message;
        const exchange = ev.data.exchange;
        const request = exchange.data;
        const senderDevice = message.get('senderDevice');
        console.debug("Sync request data:", request);
        if (request.ttl && (Date.now() - message.get('sent')) > request.ttl) {
            console.warn("Dropping stale sync request from device:", senderDevice);
            return;
        }
        console.info("Handling sync request:", request.type, ev.id);
        let responder;
        if (request.type === 'contentHistory') {
            responder = new ContentHistoryResponder(ev.id, senderDevice);
        } else if (request.type === 'deviceInfo') {
            responder = new DeviceInfoResponder(ev.id, senderDevice);
        } else {
            throw new Error("Unexpected sync-request type: " + request.type);
        }
        await responder.process(request);
    };
})();
