# Changelog

## [0.2.0](https://github.com/lg-epitech/yapd/compare/v0.1.0...v0.2.0) (2026-10-03)


### Features

* address existing agent threads by voice through the shortcut ([e02198e](https://github.com/lg-epitech/yapd/commit/e02198e3c320d4ffe8cebead4fc8d439c3c93da8))
* let the service tier be set alongside a configured model ([#16](https://github.com/lg-epitech/yapd/issues/16)) ([1754c07](https://github.com/lg-epitech/yapd/commit/1754c07cb961e339b664fbfd83e56123df38d055))
* **menu:** add a menu bar app and an api to turn yapd on and off ([aa24f68](https://github.com/lg-epitech/yapd/commit/aa24f68d1da130bc97d594f9a7d0d3b5166f9eef))
* **menu:** add a menu bar app and an api to turn yapd on and off ([aa938c2](https://github.com/lg-epitech/yapd/commit/aa938c2f6b6cbc278d168ddf11a089169e62d672))
* **menu:** give the menu bar icon its own speech bubble mark ([2257db7](https://github.com/lg-epitech/yapd/commit/2257db7d18f4ae26d067e68fb158164a66a9ddfb))
* **menu:** give the menu bar icon its own speech bubble mark ([55e4d17](https://github.com/lg-epitech/yapd/commit/55e4d17b1361a2e3b1fb7203f6f95047ba7d989f))
* **routing:** address T3 Code threads by voice ([9a6babe](https://github.com/lg-epitech/yapd/commit/9a6babeca716c0284d9dcfb11e952009e2dbc90f))
* send follow-ups to agents on other machines over ssh ([#15](https://github.com/lg-epitech/yapd/issues/15)) ([1ef7dd2](https://github.com/lg-epitech/yapd/commit/1ef7dd25958bc71c68582384cf8554007eff9868))
* start agent sessions by dictating to yapd ([#19](https://github.com/lg-epitech/yapd/issues/19)) ([bfd58b4](https://github.com/lg-epitech/yapd/commit/bfd58b46cf0dd5a6d65655081797ccd89630c0fa))
* **store:** add local sqlite storage ([18abacd](https://github.com/lg-epitech/yapd/commit/18abacd5aec60545f3accbb5785e6a11bb764809))
* **store:** keep yapd's own state in a local sqlite database ([be178c4](https://github.com/lg-epitech/yapd/commit/be178c4449174160b0528a4523654ace3b1f9d22))


### Bug Fixes

* **audio:** stop ducking other apps once yapd goes quiet ([#21](https://github.com/lg-epitech/yapd/issues/21)) ([d95898a](https://github.com/lg-epitech/yapd/commit/d95898aa1eec8591ea5a9202d7d53a0d610be238))
* **audio:** stop yapd hearing itself before its echo canceller has learnt its voice ([#22](https://github.com/lg-epitech/yapd/issues/22)) ([ca362fc](https://github.com/lg-epitech/yapd/commit/ca362fc756dc9b5ecbd917cd05ac22473d0a0592))
* bind generic pointers to the latest reading and keep archived reads retryable ([9ca044b](https://github.com/lg-epitech/yapd/commit/9ca044b88bc1dbe70daa940cf224ea3e9f52880c))
* check ambiguity against every thread, scope expected replies, and retry each machine on its own ([dfa941e](https://github.com/lg-epitech/yapd/commit/dfa941e0ec1ec78b2ce6ebacec6d395c2c5da710))
* **effect:** correct cancellation and resource ownership ([89e9e7c](https://github.com/lg-epitech/yapd/commit/89e9e7cf2c8f1a5962007ba07c988e145b1e6fae))
* hold named machines as constraints and never rearm consumed follow-ups ([0ee54ac](https://github.com/lg-epitech/yapd/commit/0ee54acb5c89d9a305c6808407e1505b71401880))
* keep cut-off updates in history and let a machine name its only thread ([665d8d8](https://github.com/lg-epitech/yapd/commit/665d8d88c3c3c78891733f81edec1aec2a9bc410))
* keep listening while working out a reply to follow-ups ([#13](https://github.com/lg-epitech/yapd/issues/13)) ([94b5488](https://github.com/lg-epitech/yapd/commit/94b54882d99aeefada2f3c5d6ef52f2a8a049af6))
* load the dictation model on a fresh install and try again after a failure ([#20](https://github.com/lg-epitech/yapd/issues/20)) ([92c5a68](https://github.com/lg-epitech/yapd/commit/92c5a682fbfa13ce0e4beac56e26d1b4d652826c))
* **menu:** drop dictations, drafts and pending speech when turned off ([5fe6a56](https://github.com/lg-epitech/yapd/commit/5fe6a5653933218ad80301655630cb9de3674cdf))
* **menu:** drop pending work before waiting on cleanup ([c10c141](https://github.com/lg-epitech/yapd/commit/c10c14131997e434e9d90ace4495e5a2d9685c52))
* **menu:** drop stale presses, dropped drafts' work and duplicate replays ([07afff7](https://github.com/lg-epitech/yapd/commit/07afff71a12cd5e7d4c6c7d61e8630c1da1777cb))
* **menu:** guard replies to replays and keep replays asked for after off and on ([de84eb7](https://github.com/lg-epitech/yapd/commit/de84eb7cffeba3ab3459d0cfa69e060eedf3572d))
* **menu:** ignore helper presses until it confirms the keys it holds ([a93a1f7](https://github.com/lg-epitech/yapd/commit/a93a1f7f2068b3fd486d04c5df54457d9067fd93))
* **menu:** ignore late presses and stop reading on every turn off ([9b68454](https://github.com/lg-epitech/yapd/commit/9b684543c968721e5c03bc50f245bc983112eb53))
* **menu:** keep hooks for pending replays and start the shortcut off until known ([36dbf35](https://github.com/lg-epitech/yapd/commit/36dbf35ad32feed06552fc03830afa04d1ba40ba))
* **menu:** keep replies to heard updates deliverable and drop late acks after off ([ac46e0b](https://github.com/lg-epitech/yapd/commit/ac46e0b361e3d24dbaa1369569118bcb3a8afebb))
* **menu:** leave heard updates' hooks waiting instead of tracking evictions ([3c0e01a](https://github.com/lg-epitech/yapd/commit/3c0e01a552adebe2cf85c6580bb44a66a1328db5))
* **menu:** rename the app's state type so it doesn't shadow swiftui ([d4492a6](https://github.com/lg-epitech/yapd/commit/d4492a64a3aad9837004a17597e610895cc71a33))
* name the project in the hook so remote sessions announce their repository ([#14](https://github.com/lg-epitech/yapd/issues/14)) ([7d8d70b](https://github.com/lg-epitech/yapd/commit/7d8d70bd7dc3ce980cb9b8b23e44d8667a2b3f08))
* note delivery notices, keep unplayed updates, and keep failures in status reports ([f22278f](https://github.com/lg-epitech/yapd/commit/f22278f4eac205b6887110ecb48e647d0592c146))
* note everything yapd says about work and refresh what it knows before deciding ([9c737c1](https://github.com/lg-epitech/yapd/commit/9c737c1f2b4a384ded9b43f32af88dbec9918bdc))
* re-list threads for answers and let a machine name qualify a thread ([381e0fd](https://github.com/lg-epitech/yapd/commit/381e0fdf1c94dab5f7c2cf76c1ab652e1a5148fd))
* read long updates in full by rendering them in parts ([#10](https://github.com/lg-epitech/yapd/issues/10)) ([813ff78](https://github.com/lg-epitech/yapd/commit/813ff78b1a30058d0989b50c4cb249b028ee05e1))
* read waiting state from the shell and reconcile sends across the whole thread ([17c2b61](https://github.com/lg-epitech/yapd/commit/17c2b61d49c5edc75f2bc150f94f03f542305371))
* rebuild playback order at the press and reconcile sends to archived threads ([d700949](https://github.com/lg-epitech/yapd/commit/d700949951da83ca597f85e3f87286691661ecd3))
* reconcile sends to unlisted threads and key expected follow-ups by message ([82b3a93](https://github.com/lg-epitech/yapd/commit/82b3a93be7689e820766974a3afbb0e137b051d5))
* refresh threads for answers, keep history for dictations in flight, and hear quick replies ([c03eee7](https://github.com/lg-epitech/yapd/commit/c03eee7b8aa2d3171bc1f1311d7d4f6aa79bf324))
* require evidence that sets the thread apart, and match sanitized messages ([0126e8b](https://github.com/lg-epitech/yapd/commit/0126e8b61d6abc978eb44be84c149602da2a695e))
* resolve references against what had played when the dictation began ([9ed4b15](https://github.com/lg-epitech/yapd/commit/9ed4b15ada01c6dcce42df1aed07235267ea4340))
* resolve spoken references by playback order and reconcile uncertain sends ([3c5754b](https://github.com/lg-epitech/yapd/commit/3c5754baca483f385e5c66c6358c556784c4ad26))
* **routing:** reject stale references and refresh thread matches ([f372dff](https://github.com/lg-epitech/yapd/commit/f372dff455971d8e5442f524330be3d171834aca))
* stop passing acknowledgements to the agent and reading echoed replies ([#9](https://github.com/lg-epitech/yapd/issues/9)) ([7313c87](https://github.com/lg-epitech/yapd/commit/7313c87568c70f3522dc6c6499c6ced3c77b4dc9))
* stop sending the agent replies that tell it to do nothing ([#12](https://github.com/lg-epitech/yapd/issues/12)) ([33fcddb](https://github.com/lg-epitech/yapd/commit/33fcddb52918a917b727adbc218a76f6688390ab))
* **t3code:** find replies behind pending turns ([e31b761](https://github.com/lg-epitech/yapd/commit/e31b7610c19b62694186cf8800d434b64fe5d3f5))
* **t3code:** find replies behind pending turns ([6aae981](https://github.com/lg-epitech/yapd/commit/6aae9816d8e723ec3c3a2a77e5e45b83b7bc0ef2))
* **voice:** queue multiple follow-ups per update ([57f1d64](https://github.com/lg-epitech/yapd/commit/57f1d64f3710de46d2f64322f52a1c33896187c3))
* weave the project name into the opening sentence of updates ([#11](https://github.com/lg-epitech/yapd/issues/11)) ([6852e79](https://github.com/lg-epitech/yapd/commit/6852e79fdb322fa9e4a1fa058ec4450e12f0c542))


### Performance Improvements

* run kokoro in its own process, on the gpu ([#18](https://github.com/lg-epitech/yapd/issues/18)) ([89b8af6](https://github.com/lg-epitech/yapd/commit/89b8af606d0034f2ce0876d88a807ace6bb18f8c))
* start codex threads ahead and keep the user's mcp servers out ([#17](https://github.com/lg-epitech/yapd/issues/17)) ([87f0295](https://github.com/lg-epitech/yapd/commit/87f02959d191312969d9c160f576c55570fcc1f8))


### Reverts

* **routing:** address T3 Code threads by voice ([6d5a4fe](https://github.com/lg-epitech/yapd/commit/6d5a4fe716f168c37d8223d682fbd9c03334f3b5))
* **store:** add local sqlite storage ([5a5fec0](https://github.com/lg-epitech/yapd/commit/5a5fec0a5844419e98de285140d34524d5b2d1f3))
