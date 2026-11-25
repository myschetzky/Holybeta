/*
 * HolyMoly – fælles regelmotor.
 *
 * Bruges uændret af serveren (Node), elev-appen (Electron) og browser-udvidelsen
 * (service worker + content script). Filen må derfor ikke bruge require/import.
 *
 * RULE_DATA er de indbyggede standardlister. Serveren sender sin (evt. nyere)
 * version af listerne til elev-appen, som sender dem videre til udvidelsen, så
 * listerne kan opdateres centralt uden at eleverne skal installere noget nyt.
 */
(function (root) {
  'use strict';

  const RULES_VERSION = 1;

  const CATEGORIES = {
    ai: { label: 'AI / chatbots', block: true },
    social: { label: 'Sociale medier og chat', block: true },
    games: { label: 'Spil', block: true },
    video: { label: 'Video og streaming', block: true },
    homework: { label: 'Lektiehjælp og opgavebanker', block: true },
    proxy: { label: 'Proxy, VPN og omgåelse', block: true },
    remote: { label: 'Fjernstyring', block: true },
    vm: { label: 'Virtuel maskine', block: true },
    translate: { label: 'Oversættelse', block: false },
    custom: { label: 'Lærerens egne blokeringer', block: true },
    exam: { label: 'Ikke tilladt i prøven', block: true },
  };

  const RULE_DATA = {
    version: RULES_VERSION,
    domains: {
      ai: [
        'openai.com', 'chatgpt.com', 'chat.com', 'oaiusercontent.com', 'oaistatic.com', 'sora.com',
        'claude.ai', 'claude.com', 'anthropic.com', 'claudeusercontent.com',
        'perplexity.ai', 'pplx.ai', 'grok.com', 'x.ai', 'grok.x.com',
        'gemini.google.com', 'bard.google.com', 'aistudio.google.com', 'notebooklm.google.com',
        'labs.google', 'gemini.google',
        'copilot.microsoft.com', 'copilot.cloud.microsoft', 'sydney.bing.com',
        'deepseek.com', 'chat.deepseek.com', 'mistral.ai', 'chat.mistral.ai', 'le-chat.ai',
        'poe.com', 'character.ai', 'beta.character.ai', 'you.com', 'phind.com',
        'meta.ai', 'pi.ai', 'inflection.ai', 'jasper.ai', 'writesonic.com', 'chatsonic.com',
        'quillbot.com', 'chatpdf.com', 'humata.ai', 'chatgot.io', 'chatgptfree.ai',
        'chat.qwen.ai', 'qwenlm.ai', 'kimi.ai', 'kimi.com', 'moonshot.cn', 'doubao.com',
        'z.ai', 'chatglm.cn', 'manus.im', 'genspark.ai', 'monica.im', 'merlin.foyer.work',
        'getmerlin.in', 'sider.ai', 'hix.ai', 'humbot.ai', 'undetectable.ai', 'stealthgpt.ai',
        'smodin.io', 'aithor.com', 'jenni.ai', 'textcortex.com', 'rytr.me', 'copy.ai',
        'writecream.com', 'easy-peasy.ai', 'deepai.org', 'huggingface.co', 'hf.space',
        'lmarena.ai', 'chat.lmsys.org', 'openrouter.ai', 'together.ai', 'groq.com',
        'cohere.com', 'coral.cohere.com', 'llama.meta.com', 'ollama.com', 'blackbox.ai',
        'codeium.com', 'cursor.com', 'v0.dev', 'bolt.new', 'lovable.dev', 'replit.com',
        'duck.ai', 'brave.com/leo', 'chatbotapp.ai', 'chatbot.app', 'chatgptdanmark.dk',
        'askyourpdf.com', 'scholarcy.com', 'consensus.app', 'elicit.com', 'scite.ai',
        'gptzero.me', 'zerogpt.com', 'napkin.ai', 'gamma.app', 'tome.app', 'beautiful.ai',
        'heygen.com', 'suno.com', 'udio.com', 'midjourney.com', 'leonardo.ai', 'ideogram.ai',
      ],
      social: [
        'snapchat.com', 'snap.com', 'sc-cdn.net', 'snapkit.com',
        'instagram.com', 'cdninstagram.com', 'ig.me',
        'tiktok.com', 'tiktokv.com', 'tiktokcdn.com', 'tiktokcdn-eu.com', 'byteoversea.com', 'ttwstatic.com',
        'facebook.com', 'fb.com', 'fbcdn.net', 'fb.me', 'messenger.com', 'm.me',
        'likee.video', 'likee.com', 'like.video',
        'x.com', 'twitter.com', 'twimg.com', 't.co',
        'threads.net', 'threads.com', 'reddit.com', 'redd.it', 'redditmedia.com',
        'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net',
        'whatsapp.com', 'whatsapp.net', 'wa.me', 'telegram.org', 't.me', 'telegram.me',
        'pinterest.com', 'pinterest.dk', 'tumblr.com', 'bereal.com', 'vsco.co',
        'omegle.com', 'ome.tv', 'chatroulette.com', 'kik.com', 'yubo.live', 'wizz.chat',
        'linktr.ee', 'bsky.app', 'mastodon.social', 'quora.com', 'ask.fm', 'tellonym.me',
        'ngl.link', 'sendit.app', 'lemon8-app.com', 'vk.com', 'weibo.com',
      ],
      games: [
        'roblox.com', 'rbxcdn.com', 'minecraft.net', 'poki.com', 'poki.dk', 'crazygames.com',
        'coolmathgames.com', 'friv.com', 'y8.com', 'miniclip.com', 'krunker.io', 'slither.io',
        'agar.io', 'diep.io', 'shellshock.io', '1v1.lol', 'now.gg', 'nowgg.fun',
        'play.geforcenow.com', 'xbox.com/play', 'epicgames.com', 'fortnite.com',
        'store.steampowered.com', 'steamcommunity.com', 'steampowered.com', 'itch.io',
        'chess.com', 'lichess.org', 'gameflare.com', 'kongregate.com', 'armorgames.com',
        'addictinggames.com', 'gamesgames.com', 'spele.nl', 'spilgames.com', 'spil.dk',
        'girlsgogames.com', 'games.co.uk', 'silvergames.com', 'kizi.com', 'yandex.com/games',
        'geoguessr.com', 'skribbl.io', 'gartic.io', 'jklm.fun', 'bonk.io', 'smashkarts.io',
        'bloxd.io', 'eaglercraft.com', 'classroom6x.com', 'unblocked-games.s3.amazonaws.com',
        'retrogames.cc', 'emulatorgames.net', 'playretrogames.com', 'gba.ninja',
        'mathplayground.com', 'hoodamath.com', 'paper-io.com', 'zombsroyale.io', 'surviv.io',
        'moomoo.io', 'hole-io.com', 'snake.io', 'venge.io', 'ev.io', 'kirka.io',
      ],
      video: [
        'youtube.com', 'youtu.be', 'youtube-nocookie.com', 'ytimg.com', 'googlevideo.com',
        'netflix.com', 'nflxvideo.net', 'twitch.tv', 'ttvnw.net', 'kick.com',
        'disneyplus.com', 'max.com', 'hbomax.com', 'viaplay.dk', 'viaplay.com',
        'tv2.dk/play', 'play.tv2.dk', 'primevideo.com', 'skyshowtime.com', 'crunchyroll.com',
        'dailymotion.com', 'vimeo.com', '9gag.com', 'ifunny.co', 'rumble.com',
        'spotify.com', 'soundcloud.com',
      ],
      homework: [
        'chegg.com', 'coursehero.com', 'brainly.com', 'brainly.co', 'brainly.in', 'studocu.com',
        'gauthmath.com', 'gauth.com', 'photomath.com', 'photomath.net',
        'mathway.com', 'symbolab.com', 'socratic.org', 'cymath.com', 'mathpapa.com',
        'wolframalpha.com', 'bartleby.com', 'numerade.com', 'slader.com', 'litcharts.com',
        'sparknotes.com', 'gradesaver.com', 'shmoop.com', 'enotes.com', 'opgavebanken.dk',
        'studienet.dk', 'opgaver.com', 'dkopgaver.dk', 'lektier.dk', 'skoleopgaver.dk',
        'studiz.dk', 'mattehjelp.no', 'answers.com', 'homeworkify.net', 'homeworkify.st',
        'scribd.com', 'papersowl.com', 'essaypro.com', 'ukessays.com', 'kunduz.com',
        'questionai.com', 'studyx.ai', 'answerai.pro', 'solvely.ai', 'mathgpt.ai',
      ],
      proxy: [
        'croxyproxy.com', 'croxyproxy.rocks', 'croxy.network', 'croxy.org', 'proxysite.com',
        'proxyium.com', 'kproxy.com', 'hidester.com', 'hide.me', 'hidemyass.com',
        'blockaway.net', '4everproxy.com', 'plainproxies.com', 'proxyscrape.com',
        'whoer.net', 'vpnbook.com', 'proxfree.com', 'unblock-websites.com', 'unblockit.how',
        'genmirror.com', 'hidemy.io', 'proxy-free.com', 'filterbypass.me', 'atozproxy.com',
        'megaproxy.com', 'sitenable.com', 'siteget.net', 'freeproxy.win', 'proxyorb.com',
        'translatetheweb.com', 'torproject.org', 'tor2web.org', 'onion.ws', 'psiphon.ca',
        'psiphon3.com', 'ultrasurf.us', 'windscribe.com', 'protonvpn.com', 'nordvpn.com',
        'expressvpn.com', 'surfshark.com', 'hotspotshield.com', 'tunnelbear.com',
        'urban-vpn.com', 'browsec.com', 'hola.org', 'zenmate.com', 'setupvpn.com',
        'interstellar.ws', 'holyubg.com', 'titaniumnetwork.org', 'doge-unblocker.com',
        'ultraviolet.dev', 'rammerhead.org', 'womginx.com', 'shadow.tech', 'mightyapp.com',
        'rdpwindows.com', 'browserling.com', 'hyperbeam.com', 'neverinstall.com',
      ],
      remote: [
        'anydesk.com', 'teamviewer.com', 'remotedesktop.google.com', 'parsec.app',
        'rustdesk.com', 'splashtop.com', 'getscreen.me', 'meshcentral.com', 'remotepc.com',
      ],
      translate: [
        'translate.google.com', 'translate.google.dk', 'deepl.com', 'bing.com/translator',
        'translator.microsoft.com', 'reverso.net', 'papago.naver.com', 'translate.yandex.com',
        'glosbe.com', 'ordbog.gyldendal.dk/oversaet',
      ],
    },

    /* Regler hvor kun en del af et ellers tilladt domæne er blokeret. */
    pathRules: [
      { host: 'bing.com', path: '/chat', category: 'ai' },
      { host: 'bing.com', path: '/copilotsearch', category: 'ai' },
      { host: 'bing.com', path: '/create', category: 'ai' },
      { host: 'bing.com', path: '/images/create', category: 'ai' },
      { host: 'bing.com', path: '/translator', category: 'translate' },
      { host: 'google.com', path: '/search', query: { udm: '50' }, category: 'ai' },
      { host: 'duckduckgo.com', path: '/', query: { ia: 'chat' }, category: 'ai' },
      { host: 'duckduckgo.com', path: '/chat', category: 'ai' },
      { host: 'search.brave.com', path: '/ask', category: 'ai' },
      { host: 'microsoft.com', path: '/copilot', category: 'ai' },
      { host: 'microsoft365.com', path: '/chat', category: 'ai' },
      { host: 'office.com', path: '/chat', category: 'ai' },
      { host: 'm365.cloud.microsoft', path: '/chat', category: 'ai' },
      { host: 'canva.com', path: '/ai', category: 'ai' },
      { host: 'canva.com', path: '/magic', category: 'ai' },
      { host: 'notion.so', path: '/ai', category: 'ai' },
      { host: 'yandex.com', path: '/games', category: 'games' },
      { host: 'xbox.com', path: '/play', category: 'games' },
      { host: 'tv2.dk', path: '/play', category: 'video' },
    ],

    /*
     * Hosts hvor elever typisk lægger "unblocked games"/proxy-sider. Her kigger vi
     * efter mistænkelige ord i stien.
     */
    genericHosts: [
      'sites.google.com', 'github.io', 'gitlab.io', 'glitch.me', 'vercel.app', 'netlify.app',
      'pages.dev', 'web.app', 'firebaseapp.com', 'replit.app', 'repl.co', 'onrender.com',
      'weebly.com', 'wixsite.com', 'neocities.org', 'surge.sh', 'herokuapp.com',
      'blogspot.com', 'wordpress.com', 'carrd.co', 's3.amazonaws.com', 'codehs.com',
      'codepen.io', 'jsfiddle.net',
    ],
    suspiciousWords: [
      ['unblocked', 'games'], ['unblock', 'proxy'], ['webproxy', 'proxy'],
      ['ultraviolet', 'proxy'], ['rammerhead', 'proxy'], ['interstellar', 'proxy'],
      ['eaglercraft', 'games'], ['1v1lol', 'games'], ['retro-bowl', 'games'], ['retrobowl', 'games'],
      ['slope-game', 'games'], ['cookie-clicker', 'games'], ['cookieclicker', 'games'],
      ['geometry-dash', 'games'], ['subway-surfers', 'games'], ['gpt4free', 'ai'],
    ],

    /*
     * Programmer (procesnavne uden .exe, små bogstaver). Navnet matches som
     * substring af procesnavnet.
     */
    apps: {
      ai: ['chatgpt', 'claude', 'perplexity', 'copilot', 'grok', 'deepseek', 'gemini', 'poe',
        'msty', 'lm studio', 'lmstudio', 'ollama', 'jan', 'gpt4all', 'cursor', 'windsurf'],
      social: ['discord', 'whatsapp', 'telegram', 'snapchat', 'instagram', 'tiktok',
        'messenger', 'facebook', 'signal', 'slack', 'skype', 'viber', 'wechat', 'line'],
      games: ['steam', 'steamwebhelper', 'epicgameslauncher', 'robloxplayer', 'robloxplayerbeta',
        'robloxstudio', 'minecraft', 'minecraftlauncher', 'fortniteclient', 'fortnitelauncher',
        'valorant', 'riotclientservices', 'leagueclient', 'league of legends', 'battle.net',
        'overwatch', 'cs2', 'csgo', 'dota2', 'rocketleague', 'gta5', 'gtavlauncher',
        'eadesktop', 'ubisoftconnect', 'upc', 'gog galaxy', 'galaxyclient',
        'xboxapp', 'itch', 'heroic', 'lutris', 'osu!', 'osu', 'terraria',
        'among us', 'brawlhalla', 'genshinimpact', 'starrail', 'rainbowsix', 'apex',
        'r5apex', 'pubg', 'tslgame', 'chess', 'solitaire', 'minesweeper', 'candycrush',
        'geometrydash', 'stumbleguys', 'fallguys', 'clashroyale'],
      video: ['spotify', 'netflix', 'vlc', 'disneyplus', 'twitch', 'obs64', 'obs'],
      proxy: ['openvpn', 'wireguard', 'nordvpn', 'protonvpn', 'expressvpn', 'surfshark',
        'windscribe', 'psiphon', 'ultrasurf', 'tor', 'torbrowser', 'hotspotshield',
        'tunnelbear', 'cyberghost', 'mullvad', 'hola', 'urbanvpn',
        'proxifier', 'shadowsocks', 'v2ray', 'clash for windows', 'clash verge'],
      remote: ['anydesk', 'teamviewer', 'parsec', 'rustdesk', 'splashtop', 'chrome remote desktop',
        'remoting_host', 'getscreen', 'vncviewer', 'tvnserver', 'ammyy', 'supremo', 'radmin',
        'remotepc'],
      homework: ['photomath', 'mathway', 'gauthmath'],
      vm: ['virtualbox', 'virtualboxvm', 'vboxheadless', 'vmware', 'vmware-vmx', 'vmplayer', 'vmware fusion',
        'prl_client_app', 'parallels desktop', 'prl_vm_app', 'utm', 'qemu-system-x86_64', 'qemu-system-aarch64',
        'vmconnect', 'windowssandbox', 'windowssandboxclient', 'multipass', 'vmware workstation', 'bluestacks',
        'hd-player', 'ldplayer', 'noxplayer', 'memu', 'android studio emulator', 'qemu-system-x86_64-headless'],
      translate: ['deepl'],
    },

    /*
     * Programmer der er kendt som almindelige arbejds- og systemprogrammer (Windows + macOS).
     * Et program i forgrunden, der hverken er på denne liste, en browser eller forbudt,
     * giver GUL lampe ("ukendt program") – aldrig rød. Læreren kan tillade det med ét klik.
     */
    knownApps: [
      // Windows-system
      'explorer', 'searchhost', 'searchapp', 'searchui', 'startmenuexperiencehost', 'shellexperiencehost',
      'lockapp', 'logonui', 'taskmgr', 'systemsettings', 'systemsettingsbroker', 'snippingtool', 'screenclippinghost',
      'calculatorapp', 'calculator', 'calc', 'notepad', 'mspaint', 'paint', 'photos', 'microsoft.photos',
      'windowsterminal', 'wt', 'cmd', 'powershell', 'pwsh', 'conhost', 'openwith', 'rundll32', 'consent',
      'credentialuibroker', 'filepicker', 'pickerhost', 'textinputhost', 'ctfmon', 'mmc', 'control',
      'sndvol', 'hxoutlook', 'hxcalendarappimm', 'olk', 'widgets', 'msedgewebview2', 'setup', 'msiexec',
      // Office og skole
      'winword', 'excel', 'powerpnt', 'onenote', 'onenoteim', 'outlook', 'msteams', 'ms-teams', 'teams',
      'mspub', 'msaccess', 'visio', 'onedrive', 'acrobat', 'acrord32', 'foxitpdfreader', 'sumatrapdf',
      'geogebra', 'geogebra classic', 'geogebra classic 6', 'maple', 'maplew', 'mathematica', 'wolframnb',
      'matlab', 'ti-nspire cx cas student software', 'logger pro', 'audacity', 'gimp', 'inkscape',
      'photoshop', 'illustrator', 'indesign', 'adobe premiere pro', 'afterfx', 'lightroom', 'blender',
      'code', 'devenv', 'pycharm64', 'pycharm', 'idea64', 'idea', 'python', 'pythonw', 'thonny', 'idle',
      'jupyter', 'rstudio', 'arduino ide', 'arduino', 'processing', 'notepad++', 'sublime_text',
      'libreoffice', 'soffice', 'soffice.bin', 'zoom', 'zoom.us', 'webex', 'dropbox', 'google drive',
      'mathcad', 'spss', 'stats', 'excel online', 'wordmat', 'holymoly', 'electron',
      // macOS-system og Apple-programmer
      'finder', 'dock', 'systemuiserver', 'loginwindow', 'screensaverengine', 'securityagent',
      'usernotificationcenter', 'notificationcenter', 'control center', 'controlcenter', 'spotlight',
      'system settings', 'system preferences', 'coreservicesuiagent', 'universalcontrol', 'windowmanager',
      'pages', 'keynote', 'numbers', 'textedit', 'preview', 'notes', 'reminders', 'calendar', 'mail',
      'contacts', 'terminal', 'iterm2', 'activity monitor', 'screenshot', 'font book', 'dictionary',
      'quicktime player', 'archive utility', 'installer', 'keychain access', 'garageband', 'imovie',
      'xcode', 'photos', 'freeform', 'stickies', 'grapher', 'digital color meter', 'image capture',
      'microsoft word', 'microsoft excel', 'microsoft powerpoint', 'microsoft onenote', 'microsoft outlook',
      'microsoft teams', 'microsoft teams (work or school)', 'visual studio code', 'adobe acrobat reader',
      'adobe acrobat', 'onedrive', 'google drive', 'zoom.us',
    ],

    /*
     * AI-endepunkter som programmer (ikke kun browsere) taler med. Bruges af
     * netværksovervågningen: Har Word, Python eller et ukendt program en åben forbindelse
     * hertil, bruger programmet AI. Lagring (OneDrive, iCloud, Google Drive …) er ikke med.
     */
    aiEndpoints: [
      'api.openai.com', 'chatgpt.com', 'openai.com', 'oaiusercontent.com', 'api.anthropic.com', 'claude.ai',
      'generativelanguage.googleapis.com', 'aiplatform.googleapis.com', 'gemini.google.com',
      'openai.azure.com', 'cognitiveservices.azure.com', 'copilot.microsoft.com', 'copilot.cloud.microsoft',
      'sydney.bing.com', 'api.mistral.ai', 'api.groq.com', 'api.together.xyz', 'openrouter.ai', 'api.deepseek.com',
      'api.perplexity.ai', 'api.x.ai', 'api.cohere.ai', 'api.cohere.com', 'api-inference.huggingface.co',
      'router.huggingface.co', 'api.fireworks.ai', 'api.replicate.com', 'api.deepinfra.com', 'api.moonshot.cn',
      'dashscope.aliyuncs.com', 'api.githubcopilot.com', 'copilot-proxy.githubusercontent.com',
      'api.individual.githubcopilot.com', 'api.codeium.com', 'server.codeium.com', 'api2.cursor.sh',
      'api.cursor.sh', 'tabnine.com', 'api.writesonic.com', 'api.quillbot.com', 'api.grammarly.ai',
      'chat.qwen.ai', 'kimi.com', 'meta.ai', 'poe.com', 'character.ai',
    ],

    /*
     * AI-knapper og -paneler INDE I tilladte sider (Google Docs, Gmail, Word Online …).
     * Udvidelsen skjuler dem, så de ikke kan bruges. Kan opdateres centralt via rules-override.
     */
    aiUi: [
      { host: 'docs.google.com', selectors: ['[aria-label*="Gemini" i]', '[data-tooltip*="Gemini" i]', '[aria-label*="Help me" i]', '[aria-label*="Hjælp mig" i]', '[aria-label*="Ask Gemini" i]'] },
      { host: 'mail.google.com', selectors: ['[aria-label*="Gemini" i]', '[data-tooltip*="Gemini" i]', '[aria-label*="Help me write" i]', '[aria-label*="Hjælp mig med at skrive" i]'] },
      { host: 'drive.google.com', selectors: ['[aria-label*="Gemini" i]', '[data-tooltip*="Gemini" i]'] },
      { host: 'classroom.google.com', selectors: ['[aria-label*="Gemini" i]'] },
      { host: 'office.com', selectors: ['[aria-label*="Copilot" i]', '[title*="Copilot" i]', '[data-automation-id*="copilot" i]'] },
      { host: 'officeapps.live.com', selectors: ['[aria-label*="Copilot" i]', '[title*="Copilot" i]'] },
      { host: 'sharepoint.com', selectors: ['[aria-label*="Copilot" i]', '[title*="Copilot" i]'] },
      { host: 'onedrive.live.com', selectors: ['[aria-label*="Copilot" i]'] },
      { host: 'cloud.microsoft', selectors: ['[aria-label*="Copilot" i]', '[title*="Copilot" i]'] },
      { host: 'notion.so', selectors: ['[aria-label*="Notion AI" i]', '[aria-label*="Ask AI" i]'] },
      { host: 'canva.com', selectors: ['[aria-label*="Magic Write" i]', '[aria-label*="Magic Media" i]'] },
      { host: 'google.com', selectors: ['[aria-label*="AI Mode" i]', '[aria-label*="AI-tilstand" i]'] },
      { host: 'bing.com', selectors: ['[aria-label*="Copilot" i]', '#b_sydConvCont'] },
    ],

    /*
     * Vinduer i ellers tilladte Mac-programmer der betyder at AI bruges
     * (Apple Intelligence / Skriveværktøjer, Image Playground, ChatGPT-udvidelsen).
     */
    aiWindows: ['^Writing Tools$', '^Skriveværktøjer$', '^Image Playground$', '^Genmoji$', '^ChatGPT$', 'Apple Intelligence'],

    /* macOS bundle-id'er -> browser, så en omdøbt browser stadig genkendes. */
    macBundles: {
      'com.google.chrome': 'chrome', 'com.google.chrome.canary': 'chrome', 'org.chromium.chromium': 'chrome',
      'com.microsoft.edgemac': 'edge', 'com.brave.browser': 'brave', 'com.operasoftware.opera': 'opera',
      'com.vivaldi.vivaldi': 'vivaldi', 'company.thebrowser.browser': 'arc', 'com.apple.safari': 'safari',
      'org.mozilla.firefox': 'firefox', 'org.torproject.torbrowser': 'other', 'app.zen-browser.zen': 'firefox',
      'com.openai.atlas': 'other', 'ai.perplexity.comet': 'other',
    },

    /*
     * Domæner der altid er tilladt i prøvetilstand (login, så eleverne kan komme ind
     * på de tilladte sider). Læreren tilføjer selv prøvens sider.
     */
    examBaseAllowed: [
      'accounts.google.com', 'login.microsoftonline.com', 'login.microsoft.com', 'login.live.com',
      'account.microsoft.com', 'unilogin.dk', 'broker.unilogin.dk', 'mitid.dk', 'nemlog-in.mitid.dk',
      'netproever.dk', 'prover.dk', 'lectio.dk', 'stil.dk',
    ],

    /* Procesnavne vi ignorerer, fordi de ellers ville give falske positiver. */
    appAllow: ['originwebhelperservice', 'tortoisegit', 'tortoisesvn', 'tortoisegitproxy',
      'outlook', 'onedrive', 'teams', 'ms-teams', 'msteams'],

    /*
     * Vinduestitler og sidetitler (regex, case-insensitive). Kun præcise titler
     * eller endelser ("… - YouTube"), så artikler OM fx TikTok ikke giver falsk alarm.
     */
    titles: {
      ai: ['^ChatGPT$', '^ChatGPT \\d', '\\| ChatGPT$', '- ChatGPT$', '^Claude$', '- Claude$', '^Perplexity$',
        '- Perplexity$', '\\| Perplexity$', '^Grok$', '- Grok$', '\\| Grok$', '^Gemini$', '^Google Gemini$',
        '- Gemini$', '^Microsoft Copilot$', '^Microsoft Copilot: ', '- Microsoft Copilot$', '^Copilot$',
        '^DeepSeek$', '^DeepSeek Chat$', '- DeepSeek$', '^Le Chat$', '- Le Chat$', '^Le Chat - Mistral AI$',
        '^Poe$', '- Poe$', '^Character\\.AI$', '\\| Character\\.AI$', '^Meta AI$', '^Pi, your personal AI$',
        '^Google AI Studio$', '^NotebookLM$', '- NotebookLM$', '^Qwen Chat$', '^Kimi$', '^Duck\\.ai$',
        '^HuggingChat$', '- HuggingChat$', '\\| QuillBot( AI)?$', '^Gauth$', '^Photomath$'],
      social: ['• Instagram$', '^Instagram$', '\\| Instagram$', 'Instagram photos and videos', '\\| TikTok$',
        '^TikTok$', '^TikTok - Make Your Day$', '^Snapchat$', '- Snapchat$', '\\| Snapchat$', '\\| Facebook$',
        '^Facebook$', '^Messenger$', '\\| Messenger$', ' / X$', '^X$', '\\| Discord$', '^Discord$', '^WhatsApp$',
        '^WhatsApp Web$', '^\\(\\d+\\) WhatsApp$', '^Telegram( Web)?$', '^Likee$', '- Likee$',
        '^Reddit - Dive into anything$', ': r/\\w+$', '^Threads$', '• Threads$', '^Pinterest$', '\\| Pinterest$',
        '^BeReal\\.?$'],
      games: ['^Roblox$', '- Roblox$', '^Minecraft( \\d[\\d.]*)?$', '^Minecraft Launcher$', '^Fortnite$', '^Steam$',
        '^Poki$', '- Poki$', '\\| Poki$', '\\| CrazyGames$', '- CrazyGames$', '\\| Coolmath Games$',
        '- Coolmath Games$', '^Epic Games Launcher$', '^VALORANT$', '^League of Legends$', 'Unblocked Games',
        '^Krunker$', '^slither\\.io$', '^agar\\.io$', '^Geometry Dash$', '^Retro Bowl$', '- Retro Bowl$',
        '^Subway Surfers$', '^1v1\\.LOL$', '\\| now\\.gg$', '^Chess\\.com$', '- Chess\\.com$', '• lichess\\.org$'],
      video: ['- YouTube$', '^YouTube$', '\\| Netflix$', '^Netflix$', '- Twitch$', '^Twitch$', '\\| Disney\\+$',
        '^Disney\\+$', '\\| Kick$', '^Spotify( Premium| Free)?$', '\\| Spotify$'],
      homework: ['\\| Chegg\\.com$', '- Brainly\\.\\w+$', '\\| Course Hero$', '\\| Quizlet$', '- Studocu$',
        '\\| Mathway$', '- Symbolab$', '- Wolfram\\|Alpha$', '^Wolfram\\|Alpha'],
      proxy: ['^CroxyProxy', 'Web Proxy', 'Unblocker', '^Interstellar$', '^Tor Browser$', '^Proton VPN$',
        '^NordVPN$', '^Psiphon'],
      remote: ['^AnyDesk', '^TeamViewer', '^Chrome Remote Desktop', '^Parsec$', '^RustDesk$'],
    },

    /* og:site_name / application-name på sider (fanger proxy'ede kopier af sider). */
    siteNames: {
      ai: ['ChatGPT', 'OpenAI', 'Claude', 'Perplexity', 'Perplexity AI', 'Grok', 'Gemini',
        'Google Gemini', 'Microsoft Copilot', 'Copilot', 'DeepSeek', 'Le Chat', 'Mistral AI',
        'Poe', 'Character.AI', 'Meta AI', 'You.com', 'Phind', 'QuillBot', 'HuggingChat',
        'NotebookLM', 'Google AI Studio', 'Qwen Chat', 'Kimi'],
      social: ['Instagram', 'TikTok', 'Facebook', 'Snapchat', 'Messenger', 'X (formerly Twitter)',
        'Twitter', 'X', 'Reddit', 'Discord', 'WhatsApp', 'Telegram', 'Likee', 'Threads',
        'Pinterest', 'Tumblr', 'BeReal'],
      games: ['Roblox', 'Poki', 'CrazyGames', 'Coolmath Games', 'Krunker', 'Chess.com', 'Miniclip',
        'Y8', 'now.gg', 'Epic Games Store', 'Steam'],
      video: ['YouTube', 'Netflix', 'Twitch', 'Kick', 'Disney+', 'Viaplay', 'Spotify'],
      homework: ['Chegg', 'Course Hero', 'Brainly', 'Studocu', 'Quizlet', 'Gauth', 'Photomath',
        'Mathway', 'Symbolab', 'Wolfram|Alpha'],
      proxy: ['CroxyProxy', 'ProxySite', 'Hidester', 'KProxy'],
    },

    /* CSS-selectorer som kun findes på de pågældende tjenester (fanger proxy-kopier). */
    domSignatures: {
      ai: ['#prompt-textarea', '[data-testid="composer-speech-button"]',
        'div[contenteditable="true"][aria-label*="Claude"]', 'fieldset[data-testid="chat-input"]',
        'textarea[placeholder*="Ask Grok"]', 'textarea[placeholder*="Message DeepSeek"]',
        'textarea[placeholder*="Ask Perplexity"]', 'textarea[placeholder*="Ask Gemini"]'],
      social: ['meta[property="al:ios:app_name"][content="Instagram"]',
        'meta[property="al:ios:app_name"][content="TikTok"]',
        'meta[property="al:ios:app_name"][content="Facebook"]',
        'meta[property="al:ios:app_name"][content="Snapchat"]',
        'meta[name="apple-itunes-app"][content*="app-id=389801252"]',
        'meta[name="apple-itunes-app"][content*="app-id=835599320"]',
        'meta[name="apple-itunes-app"][content*="app-id=447188370"]'],
    },

    browsers: {
      chrome: ['chrome', 'google chrome', 'chromium', 'chromium-browser'],
      edge: ['msedge', 'microsoft edge', 'microsoft-edge'],
      brave: ['brave', 'brave browser', 'brave-browser'],
      firefox: ['firefox', 'firefox-esr', 'librewolf', 'waterfox', 'zen', 'floorp'],
      opera: ['opera', 'opera gx', 'opera_gx', 'launcher_opera'],
      vivaldi: ['vivaldi', 'vivaldi-bin'],
      arc: ['arc'],
      safari: ['safari'],
      other: ['iexplore', 'yandex', 'browser', 'duckduckgo', 'tor browser', 'maxthon', 'seamonkey',
        'palemoon', 'thorium', 'supermium', 'mullvad browser', 'sidekick', 'comet',
        'dia', 'atlas', 'chatgpt atlas', 'opera air', 'ungoogled-chromium', 'slimjet', 'epic',
        'dragon', 'iron', 'torch', 'sputnik', '360se', '360chrome', 'qqbrowser', 'sogouexplorer',
        'ucbrowser', 'avastbrowser', 'avgbrowser', 'ccleanerbrowser', 'ghost browser', 'wavebox',
        'sigmaos', 'orion', 'min', 'mercury', 'basilisk', 'k-meleon', 'midori', 'falkon',
        'qutebrowser', 'otter-browser', 'centbrowser', 'whale', 'naver whale', 'ulaa', 'coccoc',
        'chedot', 'blisk', 'polypane', 'sizzy', 'beaker', 'lunascape', 'srware iron', 'colibri'],
    },
  };

  /* ------------------------------------------------------------------ */

  function lc(s) { return String(s == null ? '' : s).toLowerCase(); }

  function normHost(h) {
    h = lc(h).trim();
    if (h.endsWith('.')) h = h.slice(0, -1);
    if (h.startsWith('www.')) h = h.slice(4);
    return h;
  }

  function hostMatches(host, domain) {
    return host === domain || host.endsWith('.' + domain);
  }

  /* chatgpt-com.translate.goog -> chatgpt.com ; my--site-dk -> my-site.dk */
  function decodeGoogHost(label) {
    return label.replace(/--/g, '\u0000').replace(/-/g, '.').replace(/\u0000/g, '-');
  }

  function safeDecode(s) {
    let out = s;
    for (let i = 0; i < 3; i++) {
      try {
        const d = decodeURIComponent(out);
        if (d === out) break;
        out = d;
      } catch (e) { break; }
    }
    return out;
  }

  const B64_RE = /^[A-Za-z0-9+/_-]{12,}={0,2}$/;
  function tryBase64(s) {
    if (!B64_RE.test(s) || s.length > 4096) return null;
    try {
      let t = s.replace(/-/g, '+').replace(/_/g, '/');
      while (t.length % 4) t += '=';
      const bin = (typeof atob === 'function') ? atob(t) : Buffer.from(t, 'base64').toString('binary');
      if (!/^[\x20-\x7e]+$/.test(bin)) return null;
      return bin;
    } catch (e) { return null; }
  }

  const EMBEDDED_HOST_RE = /(?:https?:\/\/|\/\/|^|[\s"'=(,;|@])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?=$|[\/:?#\s"'&),;|])/gi;
  const IGNORED_PARAMS = /^(utm_|ref$|referrer$|referer$|fbclid$|gclid$|msclkid$|source$|share_source$|si$|igsh$|sl$|tl$|hl$|op$|text$|ved$|ei$|oq$|aqs$|sca_|sxsrf$|client$|sourceid$|ie$)/i;

  /**
   * Bygger en klassifikator ud fra regeldata + klassens indstillinger.
   * config = { categories: {ai:true,...}, extraBlocked: ['domæne'], allowed: ['domæne'] }
   */
  function compile(data, config) {
    data = data || RULE_DATA;
    config = config || {};
    const blockCat = {};
    // categories er enten {ai:true,...} eller en liste med præcis de kategorier, der blokeres (fx hjemme: ['ai','remote','vm'])
    const catList = Array.isArray(config.categories) ? config.categories : null;
    for (const k of Object.keys(CATEGORIES)) {
      const c = catList ? catList.includes(k) : config.categories && Object.prototype.hasOwnProperty.call(config.categories, k)
        ? !!config.categories[k] : CATEGORIES[k].block;
      blockCat[k] = c;
    }
    blockCat.custom = true;

    const allowed = (config.allowed || []).map(normHost).filter(Boolean);
    const domainEntries = []; // {host, path, category}
    const addDomain = (d, cat) => {
      d = lc(d).trim().replace(/^https?:\/\//, '').replace(/^\*\./, '');
      if (!d) return;
      const slash = d.indexOf('/');
      const host = normHost(slash >= 0 ? d.slice(0, slash) : d);
      const path = slash >= 0 ? d.slice(slash) : '';
      domainEntries.push({ host, path, category: cat });
    };
    for (const cat of Object.keys(data.domains || {})) {
      for (const d of data.domains[cat]) addDomain(d, cat);
    }
    for (const d of (config.extraBlocked || [])) addDomain(d, 'custom');
    // Længste host først, så specifikke regler vinder.
    domainEntries.sort((a, b) => (b.host.length + b.path.length) - (a.host.length + a.path.length));

    const pathRules = (data.pathRules || []).map(r => Object.assign({}, r, { host: normHost(r.host) }));
    const genericHosts = (data.genericHosts || []).map(normHost);
    const suspicious = data.suspiciousWords || [];

    const titleRes = [];
    for (const cat of Object.keys(data.titles || {})) {
      for (const src of data.titles[cat]) {
        try { titleRes.push({ re: new RegExp(src, 'i'), category: cat }); } catch (e) { /* ignorer */ }
      }
    }
    const siteNames = new Map();
    for (const cat of Object.keys(data.siteNames || {})) {
      for (const n of data.siteNames[cat]) siteNames.set(lc(n), cat);
    }
    const appEntries = [];
    for (const cat of Object.keys(data.apps || {})) {
      for (const a of data.apps[cat]) appEntries.push({ name: lc(a), category: cat });
    }
    for (const a of (config.extraBlockedApps || [])) if (lc(a).trim()) appEntries.push({ name: lc(a).trim(), category: 'custom' });
    appEntries.sort((a, b) => b.name.length - a.name.length);
    const appAllow = (data.appAllow || []).concat(config.allowedApps || []).map(lc);
    const knownApps = new Set((data.knownApps || []).concat(config.allowedApps || []).map(lc));
    const examMode = !!config.examMode;
    const examAllowed = examMode ? (data.examBaseAllowed || []).concat(config.examAllowed || []).map(normHost).filter(Boolean) : [];
    const examAllowedApps = new Set((config.examAllowedApps || []).map(lc));
    const browserMap = new Map();
    for (const b of Object.keys(data.browsers || {})) {
      for (const n of data.browsers[b]) browserMap.set(lc(n), b);
    }

    function isAllowedHost(host) {
      return allowed.some(a => hostMatches(host, a));
    }

    function result(category, rule, via) {
      return { category, label: (CATEGORIES[category] || {}).label || category, rule, via: via || 'direct', blocked: !!blockCat[category] };
    }

    function classifyHostPath(host, path, query) {
      host = normHost(host);
      if (!host) return null;
      if (isAllowedHost(host)) return null;
      path = path || '/';
      const lpath = lc(path);
      for (const r of pathRules) {
        if (!hostMatches(host, r.host)) continue;
        if (r.path && !lpath.startsWith(r.path)) continue;
        if (r.query) {
          let ok = true;
          for (const k of Object.keys(r.query)) {
            if (!query || query.get(k) !== r.query[k]) { ok = false; break; }
          }
          if (!ok) continue;
        }
        return result(r.category, r.host + (r.path || ''), 'path');
      }
      // Google Translate-proxy: chatgpt-com.translate.goog -> chatgpt.com
      if (host.endsWith('.translate.goog')) {
        const inner = decodeGoogHost(host.slice(0, -'.translate.goog'.length));
        const r = classifyHostPath(inner, path, query);
        if (r) return Object.assign(r, { via: 'translate-proxy' });
        return result('translate', 'translate.goog', 'translate-proxy');
      }
      for (const e of domainEntries) {
        if (!hostMatches(host, e.host)) continue;
        if (e.path && !lpath.startsWith(e.path)) continue;
        return result(e.category, e.host + e.path);
      }
      // Ord i værtsnavnet der afslører proxy/unblocked-sider
      if (/(^|[.-])(unblock(ed|er)?|webproxy)([.-]|$)/.test(host) || /unblock(ed|er)/.test(host)) return result('proxy', host, 'hostname');
      if (/unblocked/.test(host)) return result('games', host, 'hostname');
      if (genericHosts.some(g => hostMatches(host, g))) {
        // "proxy" tæller kun i sidens eget navn (my-proxy.vercel.app) – ikke i stien (…/design-patterns/proxy)
        if (/(^|[.-])proxy([.-]|$)|^[a-z0-9]*proxy\./.test(host)) return result('proxy', host + ' (proxy)', 'suspicious-path');
        const hay = lc(safeDecode(host + path));
        for (const [w, cat] of suspicious) {
          if (hay.includes(w)) return result(cat, host + ' (' + w + ')', 'suspicious-path');
        }
      }
      return null;
    }

    function parseUrl(u) {
      try { return new URL(u); } catch (e) { return null; }
    }

    function scanEmbedded(text, depth) {
      if (!text || depth > 2) return null;
      const s = safeDecode(String(text));
      // Fulde URL'er først
      const urlRe = /https?:\/\/[^\s"'<>]+/gi;
      let m;
      let flagged = null;
      while ((m = urlRe.exec(s))) {
        const r = classifyUrlInner(m[0], depth + 1);
        if (r && r.blocked) return r;
        if (r && !flagged) flagged = r;
      }
      const hostRe = new RegExp(EMBEDDED_HOST_RE.source, 'gi');
      while ((m = hostRe.exec(s))) {
        const r = classifyHostPath(m[1], '/', null);
        if (r && r.blocked) return r;
        if (r && !flagged) flagged = r;
      }
      return flagged;
    }

    function classifyUrlInner(u, depth) {
      const url = parseUrl(u);
      if (!url) return null;
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      const direct = classifyHostPath(url.hostname, url.pathname, url.searchParams);
      if (direct && direct.blocked) return direct;
      if (depth > 2) return direct;
      const emb = scanUrlParts(url, depth);
      if (emb && emb.blocked) return emb;
      return direct || emb;
    }

    function scanUrlParts(url, depth) {
      let flagged = null;
      const keep = (r) => { if (r && !flagged) flagged = r; return r && r.blocked; };
      const isSearch = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.brave\.com|ecosia\.org|yahoo\.com|startpage\.com|qwant\.com)$/.test(normHost(url.hostname));
      // Indlejrede URL'er i query-parametre (proxyer, oversættere, arkiver)
      for (const [k, v] of url.searchParams) {
        if (IGNORED_PARAMS.test(k)) continue;
        if (isSearch && (k === 'q' || k === 'p' || k === 'query')) continue;
        // Billedsøgning: billedets kilde (fx et YouTube-miniaturebillede) er ikke en side eleven besøger
        if (isSearch && /^(mediaurl|iai|imgurl|imgrefurl|imageurl|riu|iurl|murl|purl|surl|thumb|thumbnail|vt|src)$/i.test(k)) continue;
        const r = scanEmbedded(v, depth);
        if (r && keep(Object.assign(r, { via: 'embedded:' + k }))) return r;
        const b = tryBase64(v);
        if (b) {
          const r2 = scanEmbedded(b, depth);
          if (r2 && keep(Object.assign(r2, { via: 'base64:' + k }))) return r2;
        }
      }
      // Indlejret i stien (web.archive.org/web/2024/https://chatgpt.com/ og lign.)
      const p = safeDecode(url.pathname);
      if (p.length > 3) {
        const r = scanEmbedded(p.replace(/^\/+/, ' '), depth);
        if (r && keep(Object.assign(r, { via: 'embedded:path' }))) return r;
        for (const seg of url.pathname.split('/')) {
          const b = tryBase64(seg);
          if (b) {
            const r2 = scanEmbedded(b, depth);
            if (r2 && keep(Object.assign(r2, { via: 'base64:path' }))) return r2;
          }
        }
      }
      if (url.hash && url.hash.length > 4) {
        const r = scanEmbedded(url.hash.slice(1), depth);
        if (r && keep(Object.assign(r, { via: 'embedded:hash' }))) return r;
      }
      return flagged;
    }

    function classifyUrl(u) {
      if (!u || typeof u !== 'string' || u.length > 8192) return null;
      const r = classifyUrlInner(u, 0);
      if (r && r.blocked) return r;
      if (examMode) {
        const url = parseUrl(u);
        if (url && (url.protocol === 'http:' || url.protocol === 'https:')) {
          const host = normHost(url.hostname);
          if (!examAllowed.some(a => hostMatches(host, a))) return result('exam', host, 'exam');
        }
      }
      return r;
    }

    /** Er programmet et kendt, almindeligt arbejds-/systemprogram? */
    const aiEndpoints = (data.aiEndpoints || []).map(normHost);
    /** Er værtsnavnet en AI-tjeneste? (bruges af netværksovervågningen) */
    function isAiHost(host) {
      const h = normHost(host);
      if (!h) return false;
      if (aiEndpoints.some(d => hostMatches(h, d))) return true;
      const r = classifyHostPath(h, '/', null);
      return !!(r && r.category === 'ai');
    }
    function aiUiSelectors(host) {
      const h = normHost(host);
      const out = [];
      for (const e of data.aiUi || []) if (hostMatches(h, normHost(e.host))) out.push(...e.selectors);
      return out;
    }
    const aiWindowRes = (data.aiWindows || []).map(src => { try { return new RegExp(src, 'i'); } catch (e) { return null; } }).filter(Boolean);
    function isAiWindow(title) { const t = String(title || '').trim(); return !!t && aiWindowRes.some(re => re.test(t)); }
    const macBundles = data.macBundles || {};
    function browserOfBundle(bundleId) { return macBundles[lc(bundleId)] || null; }

    function isKnownApp(processName) {
      const n = lc(processName).replace(/\.(exe|app)$/, '').trim();
      if (!n) return true;
      if (examMode) return examAllowedApps.has(n) || isSystemApp(n);
      if (knownApps.has(n)) return true;
      for (const k of knownApps) if (k.length >= 5 && n.startsWith(k)) return true;
      return false;
    }
    const SYSTEM_APPS = new Set(['explorer', 'searchhost', 'searchapp', 'startmenuexperiencehost', 'shellexperiencehost',
      'lockapp', 'logonui', 'taskmgr', 'textinputhost', 'consent', 'credentialuibroker', 'finder', 'dock', 'systemuiserver',
      'loginwindow', 'screensaverengine', 'securityagent', 'usernotificationcenter', 'notificationcenter', 'control center',
      'controlcenter', 'spotlight', 'coreservicesuiagent', 'windowmanager', 'system settings', 'system preferences',
      'systemsettings', 'holymoly', 'electron']);
    function isSystemApp(n) { return SYSTEM_APPS.has(n); }

    function classifyTitle(title) {
      const t = String(title || '').trim();
      if (!t) return null;
      // Opslagsværker handler OM tjenesterne – de er ikke tjenesterne.
      if (/(Wikipedia|Wikiwand|lex\.dk|Den Store Danske|Britannica|Wiktionary)\s*$/i.test(t)) return null;
      for (const { re, category } of titleRes) {
        if (re.test(t)) return result(category, re.source, 'title');
      }
      return null;
    }

    function classifySiteName(name) {
      const cat = siteNames.get(lc(name).trim());
      return cat ? result(cat, name, 'site-name') : null;
    }

    function classifyApp(processName, windowTitle) {
      let n = lc(processName).replace(/\.(exe|app)$/, '').trim();
      if (n && !appAllow.includes(n)) {
        for (const e of appEntries) {
          // Korte navne (fx "tor", "jan", "line") skal matche præcist for at undgå falske positiver.
          const hit = e.name.length <= 4 ? (n === e.name) : (n === e.name || n.startsWith(e.name) || n.includes(e.name));
          if (hit) return result(e.category, e.name, 'app');
        }
      }
      if (windowTitle && !browserOf(processName)) {
        // Titlen tjekkes kun for ikke-browsere; browsere håndteres via udvidelsen.
        const r = classifyTitle(windowTitle);
        if (r) return r;
      }
      return null;
    }

    function browserOf(processName) {
      const n = lc(processName).replace(/\.(exe|app)$/, '').trim();
      if (!n) return null;
      if (browserMap.has(n)) return browserMap.get(n);
      return null;
    }

    return {
      classifyUrl, classifyTitle, classifySiteName, classifyApp, browserOf, isKnownApp,
      isAiHost, aiUiSelectors, isAiWindow, browserOfBundle, isAllowedHost: (h) => isAllowedHost(normHost(h)),
      examMode, examAllowedList: () => examAllowed.slice(),
      isBlockedCategory: (c) => !!blockCat[c],
      blockedDomainList: () => domainEntries.filter(e => blockCat[e.category] && !e.path).map(e => e.host),
      domSignatures: () => {
        const out = [];
        for (const cat of Object.keys(data.domSignatures || {})) {
          if (!blockCat[cat]) continue;
          for (const sel of data.domSignatures[cat]) out.push({ selector: sel, category: cat });
        }
        return out;
      },
      result,
    };
  }

  /** Regex-mønstre til translate.goog-varianter af blokerede domæner (til DNR). */
  function googEncodedHosts(domains) {
    return domains.map(d => d.replace(/-/g, '--').replace(/\./g, '-'));
  }

  const api = { RULES_VERSION, CATEGORIES, RULE_DATA, compile, normHost, hostMatches, decodeGoogHost, googEncodedHosts, tryBase64 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ACRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
