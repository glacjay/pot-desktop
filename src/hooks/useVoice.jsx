import { useCallback } from 'react';
let audioContext = new (window.AudioContext || window.webkitAudioContext)();
let source = null;

export const useVoice = () => {
    const playOrStop = useCallback((data) => {
        if (source) {
            // 如果正在播放，停止播放
            source.stop();
            source.disconnect();
            source = null;
        } else {
            // 如果没在播放，开始播放
            // AudioContext 于页面加载时创建，受浏览器自动播放策略限制会一直处于
            // suspended 状态，必须在用户手势后 resume，否则无声（WebKitGTK 尤甚）。
            if (audioContext.state === 'suspended') {
                audioContext.resume();
            }
            audioContext.decodeAudioData(new Uint8Array(data).buffer, (buffer) => {
                source = audioContext.createBufferSource();
                source.buffer = buffer;
                source.connect(audioContext.destination);
                source.start();
                source.onended = () => {
                    source.disconnect();
                    source = null;
                };
            });
        }
    });

    return playOrStop;
};
