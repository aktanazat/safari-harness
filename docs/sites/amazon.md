---
name: Amazon
hosts: amazon.com
---
# Amazon

There are several saved logins for www.amazon.com; pass username aktanaazat@gmail.com to `passwords fill` for the shopping account.

## Prime
- www.amazon.com/gp/primecentral: extract returns only the account name. Read `document.body.innerText` with `eval` to get the plan, price, renewal date, and Cancel.
- /mm/pipeline/cancellation shows nothing to snapshot; start from primecentral.

## Customer-service chat
- Reach it (10-07): open www.amazon.com/gp/help/customer/contact-us; it lands on /hz/contact-us/foresight/hubgateway. The textbox at the top there is help search, not chat: Enter in it opened a help-results tab. Click the "Something else" button below the topic list ("Payment methods, charges, or gift cards"…); the one under "Get help with your order" leads to /hubgateway-resolution/…, not the chat. On /hubgateway-issues-8 click "I need help with something else". The chat opens in a new tab at www.amazon.com/message-us?…; use that tab's id.
- The message field is labelled `Type something like, "return an item"` before your first message and `Send a message` after. Its snapshot ref moved between reloads (1, then 3, then 2), so take a fresh ref from `snapshot`. End the text with a line break to send it.
- Send every message with `real_input {do: "type", tab, ref, text: "…\n", reply: 100000}` and read `reply`. Never scripted `type` + `press Enter` here: on 10-07 it broke the chat twice, first #cs-ai-error/577 ("Sorry, it looks like we hit a snag", button "Try chat again"), then a "500 - An error occurred" page. To recover, `history back` or Try chat again, then "Continue previous chat" on #resume-chat.
- The bot ("Messaging Assistant") answers first and steers with buttons. A "Choose an item" dialog lists your orders with a search box; the message field is disabled until you pick one. Then quick replies ("Yes, that's right", "It's damaged or defective", "Item doesn't work"). `real_input` clicks worked on all of them.
- To reach a person (10-07): after the bot's verdict pick "Yes, I have a follow up question on this", then "Chat with an associate now" ("Request a phone call" is beside it). "<Name> has joined the chat" came within seconds. The bot warns that 2 minutes without a reply may move the chat to a different associate.
- Associate lines arrive as "Name: text"; a lone initial line ("R") shows while they type. Replies took 5 s to about 2.5 min ("let me check", "let me check it with my lead"), and the tab title turns "New message received". On `reply: null`, `wait {changed: true, ms: 100000}` before writing again.
- Past the 30-day return window an associate may refuse a refund and offer a promotional credit instead; asking moved it up once, after the associate checked with a lead (10-07). The credit does not show at /gc/balance; it applies at checkout to items sold and shipped by Amazon.
- The associate closes with "Thank you for contacting Amazon…"; an "End this chat" button sits under the thread.
