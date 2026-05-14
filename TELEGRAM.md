# Telegram Bot API - Formatting Options

The Bot API supports basic formatting for messages. You can use bold, italic, underlined, strikethrough, spoiler text, block quotations as well as inline links and pre-formatted code in your bots' messages. Telegram clients will render them accordingly. You can specify text entities directly, or use markdown-style or HTML-style formatting.

Note that Telegram clients will display an alert to the user before opening an inline link ('Open this link?' together with the full URL).

Message entities can be nested, providing following restrictions are met:
- If two entities have common characters, then one of them is fully contained inside another.
- bold, italic, underline, strikethrough, and spoiler entities can contain and can be part of any other entities, except pre and code.
- blockquote and expandable_blockquote entities can't be nested.
- All other entities can't contain each other.

Links `tg://user?id=<user_id>` can be used to mention a user by their identifier without using a username. Please note:
- These links will work only if they are used inside an inline link or in an inline keyboard button. For example, they will not work, when used in a message text.
- Unless the user is a member of the chat where they were mentioned, these mentions are only guaranteed to work if the user has contacted the bot in private in the past or has sent a callback query to the bot via an inline button and doesn't have Forwarded Messages privacy enabled for the bot.

Date-time entity formatting is specified by a format string with the pattern `|[w?[dD]?[tT]?`:
- `r`: Displays the time relative to the current time.
- `w`: Displays the day of the week in the user's localized language.
- `d`: Displays the date in short form (e.g., "17.03.22").
- `D`: Displays the date in long form (e.g., "March 17, 2022").
- `t`: Displays the time in short form (e.g., "22:45").
- `T`: Displays the time in long form (e.g., "22:45:00").

## MarkdownV2 style

To use this mode, pass `MarkdownV2` in the `parse_mode` field.

```
*bold \*text*
_italic \*text_
__underline__
~strikethrough~
||spoiler||
*bold _italic bold ~italic bold strikethrough ||italic bold strikethrough spoiler||~ __underline italic bold___ bold*
[inline URL](http://www.example.com/)
[inline mention of a user](tg://user?id=123456789)
![](tg://emoji?id=5368324170671202286)
![22:45 tomorrow](tg://time?unix=1647531900&format=wDT)
![22:45 tomorrow](tg://time?unix=1647531900&format=t)
![22:45 tomorrow](tg://time?unix=1647531900&format=r)
![22:45 tomorrow](tg://time?unix=1647531900)
`inline fixed-width code`
\`\`\`
pre-formatted fixed-width code block
\`\`\`
\`\`\`python
pre-formatted fixed-width code block written in the Python programming language
\`\`\`
>Block quotation started
>Block quotation continued
>Block quotation continued
>Block quotation continued
>The last line of the block quotation
**>The expandable block quotation started right after the previous block quotation
>It is separated from the previous block quotation by an empty bold entity
>Expandable block quotation continued
>Hidden by default part of the expandable block quotation started
>Expandable block quotation continued
>The last line of the expandable block quotation with the expandability mark||
```

**Escaping rules:**
- Any character with code between 1 and 126 inclusively can be escaped anywhere with a preceding `\` character, in which case it is treated as an ordinary character and not a part of the markup. This implies that `\` character usually must be escaped with a preceding `\` character.
- Inside `pre` and `code` entities, all `` ` `` and `\` characters must be escaped with a preceding `\` character.
- Inside the `(...)` part of the inline link and custom emoji definition, all `)` and `\` must be escaped with a preceding `\` character.
- In all other places characters `_`, `*`, `[`, `]`, `(`, `)`, `~`, `` ` ``, `>`, `#`, `+`, `-`, `=`, `|`, `{`, `}`, `.`, `!` must be escaped with the preceding character `\`.
- In case of ambiguity between `italic` and `underline` entities `__` is always greedily treated from left to right as beginning or end of an underline entity, so instead of `___italic underline___` use `___italic underline_**__`, adding an empty bold entity as a separator.

**Custom emoji notes:**
- A valid emoji must be provided as an alternative value for the custom emoji.
- Custom emoji entities can only be used by bots that purchased additional usernames on Fragment or in messages directly sent by the bot to private, group and supergroup chats if the owner of the bot has a Telegram Premium subscription.

## HTML style

To use this mode, pass `HTML` in the `parse_mode` field.

```
<b>bold</b>, <strong>bold</strong>
<i>italic</i>, <em>italic</em>
<u>underline</u>, <ins>underline</ins>
<s>strikethrough</s>, <strike>strikethrough</strike>, <del>strikethrough</del>
<span class="tg-spoiler">spoiler</span>, <tg-spoiler>spoiler</tg-spoiler>
<b>bold <i>italic bold <s>italic bold strikethrough <span class="tg-spoiler">italic bold strikethrough spoiler</span></s> <u>underline italic bold</u></i> bold</b>
<a href="http://www.example.com/">inline URL</a>
<a href="tg://user?id=123456789">inline mention of a user</a>
<tg-emoji emoji-id="5368324170671202286">👍</tg-emoji>
<tg-time unix="1647531900" format="wDT">22:45 tomorrow</tg-time>
<tg-time unix="1647531900" format="t">22:45 tomorrow</tg-time>
<tg-time unix="1647531900" format="r">22:45 tomorrow</tg-time>
<tg-time unix="1647531900">22:45 tomorrow</tg-time>
<code>inline fixed-width code</code>
<pre>pre-formatted fixed-width code block</pre>
<pre><code class="language-python">pre-formatted fixed-width code block written in the Python programming language</code></pre>
<blockquote>Block quotation started\nBlock quotation continued\nThe last line of the block quotation</blockquote>
<blockquote expandable>Expandable block quotation started\nExpandable block quotation continued\nExpandable block quotation continued\nHidden by default part of the block quotation started\nExpandable block quotation continued\nThe last line of the block quotation</blockquote>
```

**Notes:**
- Only the tags mentioned above are currently supported.
- All `<`, `>` and `&` symbols that are not a part of a tag or an HTML entity must be replaced with the corresponding HTML entities (`<` with `&lt;`, `>` with `&gt;` and `&` with `&amp;`).
- All numerical HTML entities are supported.
- The API currently supports only the following named HTML entities: `&lt;`, `&gt;`, `&amp;` and `&quot;`.
- Use nested `pre` and `code` tags to define programming language for `pre` entity.
- Programming language can't be specified for standalone `code` tags.
- A valid emoji must be used as the content of the `tg-emoji` tag.
- Custom emoji entities can only be used by bots that purchased additional usernames on Fragment or in messages directly sent by the bot to private, group and supergroup chats if the owner of the bot has a Telegram Premium subscription.

## Markdown style (legacy)

This is a legacy mode, retained for backward compatibility. To use this mode, pass `Markdown` in the `parse_mode` field.

```
*bold text*
_italic text_
[inline URL](http://www.example.com/)
[inline mention of a user](tg://user?id=123456789)
`inline fixed-width code`
\`\`\`
pre-formatted fixed-width code block
\`\`\`
\`\`\`python
pre-formatted fixed-width code block written in the Python programming language
\`\`\`
```

**Notes:**
- Entities must not be nested, use parse mode `MarkdownV2` instead.
- There is no way to specify "underline", "strikethrough", "spoiler", "blockquote", "expandable_blockquote", "custom_emoji", and "date_time" entities, use parse mode `MarkdownV2` instead.
- To escape characters `_`, `*`, `` ` ``, `[` outside of an entity, prepend the character `\` before them.
- Escaping inside entities is not allowed, so entity must be closed first and reopened again: use `_snake_\__case_` for italic `snake_case` and `*2*\**2=4*` for bold `2*2=4`.
