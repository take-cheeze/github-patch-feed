import * as functions from "firebase-functions";

import fetch from 'node-fetch';

import { defineSecret } from 'firebase-functions/params';
const FEED_URL = defineSecret('GITHUB_FEED_URL');
const APP_URL = defineSecret('APP_URL');
import express = require('express');
import cors = require('cors');

import FeedParser = require('feedparser');
import humanize = require("humanize");
import escapeHtml = require('escape-html');
import { Feed } from "feed";

import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { initializeApp } from 'firebase-admin/app';

import Diff2html = require('diff2html');

initializeApp();
const db = getFirestore();
const col = db.collection("feeds");

const FEED_ITEM_MAX = 50;
const FEED_SIZE_THRESHOLD = 1 * 1024 * 1024; // 1 MB
const URL_MATCH = /^https:\/\/github.com\/([\w\-_]+)\/([\w\-_]+)\/compare\/(\w+)\.\.\.(\w+)$/;

// // Start writing Firebase Functions
// // https://firebase.google.com/docs/functions/typescript
//
// export const helloWorld = functions.https.onRequest((request, response) => {
//   functions.logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

const fetchFeed = async () => {
    const processItem = async (e) => {
        // skip github pages update
        if (e.title.includes("pushed to gh-pages at")) { return; }

        const link: string = e.link;

        const ref = await col.doc(link).get();
        if (ref.exists) {
            return;
        }

        const m = link.match(URL_MATCH)
        if (!m) {
            console.log("Skipping url:", link);
            return;
        }

        const parsed_time = Date.parse(e.Updated);

        const fetchUrl = async (url: string): Promise<string> => {
            console.log("Fetching:", url);
            const response = await fetch(FEED_URL);
            if (!response.ok) {
                console.log("feed fetch error:", response.type);
                return "";
            }
            const src = await response.text();

            if (src.length == 0) {
                return ""; // skip empty feed
            } else if (src.length > FEED_SIZE_THRESHOLD) {
                return `Data size too big: ${humanize.filesize(src.length)}`;
            } else {
                // return `<pre>${escapeHtml(src)}</pre>`;
                const diffJson = Diff2html.parse(src);
                return Diff2html.html(diffJson, {});
            }
        }

        const doc = {
            url: link,
            updated: Timestamp.fromMillis(parsed_time),
            author: e.author.name,
            title: `${e.title} (${m[3]}...${m[4]})`,
            patch: await fetchUrl(link + ".patch"),
            diff: await fetchUrl(link + ".diff"),
        };

        const docRef = col.doc(link);
        await docRef.set(doc);

        const removeOlds = async () => {
            const all_feeds = await col.orderBy("updated", "desc").select("url").get();
            const deleting_feeds = all_feeds.docs.slice(-(FEED_ITEM_MAX + 1), -1);
            if (deleting_feeds.length == 0) { return; }
            const batch = db.batch();
            for (const f of deleting_feeds) {
                batch.delete(f.ref);
            }
            await batch.commit();
        };
        await removeOlds();
    };

    console.log("Fetching:", FEED_URL);
    const response = await fetch(FEED_URL);
    if (!response.ok || !response.body) {
        console.log("feed fetch error:", response.type);
        return;
    }

    const parser = new FeedParser();
    response.body.pipe(parser)
    .on('readable', function() {
        let item;
        while (item = this.read()) {
            processItem(item);
        }
    })
    .on('error', (error) => {
        console.error(error);
    });
};

const app = express();

const generateFeed = async (field: string): Promise<string> {
    const feed_url: string = `${APP_URL}/${field}`;
    const feed = new Feed({
        title: `github-patch-feed ${field}`,
        id: feed_url,
        link: feed_url,
        updated: new Date(),
        description: "feed generated from github feed",
        author: {
            name: "take-cheeze",
            email: "takechi101010@gmail.com",
        },
        copyright: "from github",
    });
    const r = await col.orderBy("updated", "desc").limit(FEED_ITEM_MAX).get();
    for (const doc of r.docs) {
        const d = doc.data();
        feed.addItem({
            title: d.title,
            id: d.url,
            link: d.url,
            description: d[field],
            author: [
                {
                    name: d.author,
                }
            ],
            date: d.updated,
        });
    }
    return feed.atom1();
};

// Automatically allow cross-origin requests
app.use(cors({ origin: true }));

app.get('/diff', async (req, res) => {
    res.send(await generateFeed("diff"));
});
app.get('/patch', async (req, res) => {
    res.send(await generateFeed("patch"));
});
app.get('/manual', (req, res) => {
    fetchFeed();
    res.send("started manual fetch");
});

exports.main = functions.https.onRequest(app);

exports.scheduleFunction = functions.pubsub.schedule("every 5 minutes").onRun((ctx) => fetchFeed());
