async function tts(text, lang, options = {}) {
    const { utils } = options;
    const { http } = utils;
    const { fetch } = http;

    // Google Translate TTS (free, no key). ~200 char limit per request.
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&q=${encodeURIComponent(text)}&tl=${encodeURIComponent(lang)}`;
    const res = await fetch(url, { method: 'GET', responseType: 3 }); // 3 = Binary
    if (!res.ok) {
        throw `Http Request Error\nHttp Status: ${res.status}\n${JSON.stringify(res.data)}`;
    }
    const data = res.data;
    if (!data || data.length === 0) {
        throw 'Empty audio response';
    }

    // Play via system ffplay instead of WebKit WebAudio: WebKitGTK's audio
    // output is broken on this machine (AudioContext runs and GStreamer writes
    // to the pulse ringbuffer, but the pipeline corks almost immediately →
    // blip or silence; reproducible in MiniBrowser too — platform-level issue).
    // pot's run_binary allows arbitrary commands; base64 pipe avoids needing
    // any file-write API.
    const bin = String.fromCharCode.apply(null, Array.from(data));
    const b64 = btoa(bin);
    const file = `/tmp/pot_tts_${Date.now()}.mp3`;
    await utils.run('bash', [
        '-c',
        `printf %s '${b64}' | base64 -d > '${file}' && (ffplay -nodisp -autoexit -loglevel quiet '${file}' >/dev/null 2>&1; rm -f '${file}') &`,
    ]);

    // Dummy payload: pot's useVoice hook would double-play (or fail silently on
    // this broken audio path) — an undecodable 1-byte input makes it a no-op.
    return [0];
}
