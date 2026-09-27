---
name: YouTube
hosts: youtube.com, www.youtube.com, m.youtube.com, youtu.be
---
# YouTube

No sign-in is needed: the global reads YouTube as a signed-out visitor.

## In safari repl
The `youtube` global reads YouTube through the page's own data calls from a background tab of its own, without the account signature the page adds, so YouTube answers as signed out: searches and lookups never land in the owner's search or watch history, and the player is never started. All methods are reads; a video may be given as an id, a watch, Shorts, live, or embed URL, or a `youtu.be` link.

- `youtube.search(query, {limit})`: videos for a query in YouTube's order (id, url, title, channel, duration, views, published); `limit` defaults to 10.
- `youtube.getMetadata(video)`: title, channel and its URL, description, duration, views, likes, publish date, live flag, and chapters when the video has them.
- `youtube.listTranscriptLanguages(video)`: the caption tracks: language code, YouTube's name for the track, and whether it is auto-generated.
- `youtube.getTranscript(video, {lang})`: timed segments (`start`, `end` in seconds, `text`) plus the joined `text`; `lang` picks a track by code (`en`, `ko`) or name, default the video's own track.
- `youtube.getComments(video, {limit, continuation})`: top-level comments (author, text, likes, published, reply count) in "top comments" order; `limit` defaults to 20, and the answer's `continuation` pages on.

```js
const [hit] = await youtube.search("bun javascript runtime", { limit: 1 });
const info = await youtube.getMetadata(hit.videoId);
const talk = await youtube.getTranscript(hit.videoId, { lang: "en" });
console.log(info.title, info.duration, talk.text.slice(0, 200));
```
