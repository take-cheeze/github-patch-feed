import * as functions from "firebase-functions";
import {defineSecret} from "firebase-functions/params";
import {getFirestore, Timestamp} from "firebase-admin/firestore";
import {initializeApp} from "firebase-admin/app";

import {Buffer} from "node:buffer";
import fetch from "node-fetch";
import {Feed} from "feed";
import * as express from "express";
import * as cors from "cors";
import * as FeedParser from "feedparser";
import {filesize} from "humanize";
// import * as Diff2html from "diff2html";
import escapeHtml = require("escape-html");

initializeApp();
const db = getFirestore();
const col = db.collection("feeds");
const FEED_URL = defineSecret("GITHUB_FEED_URL");
const APP_URL = defineSecret("APP_URL");

const FEED_ITEM_MAX = 50;
const FEED_SIZE_THRESHOLD = 1 * 1024 * 1024; // 1 MB
/* eslint-disable max-len */
const URL_MATCH = /^https:\/\/github.com\/([\w\-_]+)\/([\w\-_]+)\/compare\/(\w+)\.\.\.(\w+)$/;

// // Start writing Firebase Functions
// // https://firebase.google.com/docs/functions/typescript
//
// export const helloWorld = functions.https.onRequest((request, response) => {
//   functions.logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

const toId = (url: string): string => {
  return Buffer.from(url).toString("base64");
};

const fetchFeed = async () => {
  const processItem = async (e: any) => {
    // skip github pages update
    if (e.title.includes("pushed to gh-pages at")) {
      return;
    }

    const link: string = e.link;

    const ref = await col.doc(toId(link)).get();
    if (ref.exists) {
      return;
    }

    const m = link.match(URL_MATCH);
    if (!m) {
      console.log("Skipping url:", link);
      return;
    }

    const parsedTime = Date.parse(e.date);

    const fetchUrl = async (url: string): Promise<string> => {
      console.log("Fetching:", url);
      const response = await fetch(url);
      if (!response.ok) {
        console.log("feed fetch error:", response.type);
        return "";
      }
      const src = await response.text();

      if (src.length == 0) {
        return ""; // skip empty feed
      } else if (src.length > FEED_SIZE_THRESHOLD) {
        return `Data size too big: ${filesize(src.length)}`;
      } else {
        return `<pre>${escapeHtml(src)}</pre>`;
        // const diffJson = Diff2html.parse(src);
        // return Diff2html.html(diffJson, {});
      }
    };

    const doc = {
      url: link,
      updated: Timestamp.fromMillis(parsedTime),
      author: e.author.name,
      title: `${e.title} (${m[3]}...${m[4]})`,
      patch: await fetchUrl(link + ".patch"),
      diff: await fetchUrl(link + ".diff"),
    };

    const docRef = col.doc(toId(link));
    await docRef.set(doc);

    const removeOlds = async () => {
      const allFeeds = await col.orderBy("updated", "desc").select("url").get();
      const deletingFeeds = allFeeds.docs.slice(FEED_ITEM_MAX, -1);
      if (deletingFeeds.length == 0) {
        return;
      }
      const batch = db.batch();
      for (const f of deletingFeeds) {
        batch.delete(f.ref);
      }
      await batch.commit();
    };
    await removeOlds();
  };

  console.log("Fetching:", FEED_URL.value());
  const response = await fetch(FEED_URL.value());
  if (!response.ok || !response.body) {
    console.log("feed fetch error:", response.type);
    return;
  }

  const parser = new FeedParser({});
  response.body.pipe(parser)
      .on("readable", function(this: any) {
        let item;
        while (/* eslint-disable no-invalid-this */ item = this.read()) {
          console.log("Processing:", item.title);
          processItem(item);
        }
      })
      .on("error", (error: any) => {
        console.error(error);
      });
};

const generateFeed = async (field: string): Promise<string> => {
  const feedUrl = `${APP_URL.value()}/${field}`;
  const feed = new Feed({
    title: `github-patch-feed ${field}`,
    id: feedUrl,
    link: feedUrl,
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
        },
      ],
      date: d.updated,
    });
  }
  return feed.atom1();
};

const f = functions.runWith({secrets: ["GITHUB_FEED_URL", "APP_URL"]});

exports.schedule = f.pubsub.schedule("every 5 minutes").onRun(() => fetchFeed());

const app = express();

// Automatically allow cross-origin requests
app.use(cors({origin: true}));

app.get("/diff", async (req, res) => {
  res.send(await generateFeed("diff"));
});
app.get("/patch", async (req, res) => {
  res.send(await generateFeed("patch"));
});
app.get("/manual", (req, res) => {
  exports.schedule();
  res.send("started manual fetch");
});

exports.main = f.https.onRequest(app);
