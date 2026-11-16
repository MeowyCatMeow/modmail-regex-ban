# Modmail Regex Ban

Automatically ban and mute people whose modmail matches a regex you choose:
spam offers, scam links, bribes and anything else you never want to answer by
hand.

## What it does

When a user's modmail matches one of your patterns, the app:

- bans them, permanently or for 1 to 365 days,
- mutes them in modmail for 3, 7 or 28 days, or permanently,
- leaves a private note for moderators saying what matched,
- archives the conversation so it leaves your inbox.

It can also send you a summary every week, month or year. It never acts on
moderators, Reddit admins or automated messages.

## Setup

1. Install the app on your subreddit.
2. Open its settings (Mod Tools → Installed Apps → Modmail Regex Ban).
3. Switch on the ready-made patterns you want. Each one shows the regex it
   uses. You can also write your own regexes, one per line.

Until you switch on or write at least one pattern, the app does nothing.

## Good to know

- **Broad patterns ban a lot of people.** A pattern like `free` bans anyone who
  uses that word. Try new patterns on a private subreddit first.
- **Permanent mute is a workaround.** Reddit only lets apps mute for 28 days,
  so the app either renews the mute every 28 days (Reddit notifies the user
  each time) or, after the first 28 days, archives whatever they send. A muted
  user can still message moderators directly outside modmail.
- **Privacy.** The app sends nothing outside Reddit and does not keep message
  contents. It keeps a list of who it banned, muted or archived, so that it
  can undo it.

## Deleted and suspended accounts

Reddit's rules require apps to erase what they keep about deleted accounts. So
once a week the app checks whether the accounts it acted on still exist.

Reddit answers "not found" for a deleted account, and also for one it has
suspended. So that a short suspension does not make the app forget someone, it
asks again ten days later and only then erases its records of them.

Once erased, the app stops renewing that user's mute and archiving their mail,
and **Undo everything** no longer covers them. Their ban on your subreddit
stays.

## Letting someone back in

**Unmute them in Reddit.** The app sees a moderator's unmute and lets go of
that user: it stops renewing their mute, and it stops auto-archiving their
mail. This works for both Permanent choices.

One case needs the settings instead. With auto-archive, the user is only muted
for the first 28 days, so after that there is nothing left to unmute. From then
on, add them to **Exempt users** in the app settings to stop the archiving.
Exempt users also works at any other time.

## Undoing everything

If a pattern turns out to be wrong, switch on **Undo everything the app has
done** at the bottom of the settings. While it is on, the app:

- unbans and unmutes everyone it banned or muted,
- moves the conversations it archived back to your inbox,
- empties its permanent-mute list,
- takes no new action.

It leaves alone any ban or mute a moderator has changed since, and it cannot
remove private notes or messages it already sent. You get a modmail when it
has finished. Switch the setting off to let the app work again.
