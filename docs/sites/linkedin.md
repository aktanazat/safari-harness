---
name: LinkedIn
hosts: linkedin.com, www.linkedin.com
---
# LinkedIn

## In safari repl
The `linkedin` global reads LinkedIn through the session in Safari, from one background tab of its own, with the same requests the LinkedIn web app makes. Requests are paced 1 to 1.75 s apart on their own. Reading the inbox or a conversation this way marks nothing as read.
- `linkedin.getMe()`: the signed-in member: name, headline, public id, profile url.
- `linkedin.getProfile(publicIdOrUrl)`: a member's profile: headline, about, location, experience, education. LinkedIn may count this as a profile view the member can see.
- `linkedin.searchPeople(query, {limit, start})`, `linkedin.searchCompanies(query, {limit, start})`: search results with a `start` for the next page.
- `linkedin.getCompany(universalNameOrUrl)`: a company page: tagline, description, industry, size, headquarters, followers.
- `linkedin.getJob(jobIdOrUrl)`: a job posting: title, company, location, posted date, description.
- `linkedin.getUserPosts(profileIdOrUrl, {limit})`: a member's recent posts with reaction and comment counts.
- `linkedin.getInbox({limit})`: the message inbox: each conversation with its participants, unread state, and last message.
- `linkedin.getConversation(conversationId, {limit})`: one conversation's messages, newest first.
- `linkedin.sendMessage({conversationId | to, text})`, `linkedin.sendInvitation(publicIdOrUrl, {note})`: drafts only until approved: each returns the exact text and sends nothing; call it again with `approved: true` once the user has approved that text.

```js
const me = await linkedin.getMe();
const { conversations } = await linkedin.getInbox({ limit: 10 });
const thread = await linkedin.getConversation(conversations[0].id, { limit: 20 });
```
