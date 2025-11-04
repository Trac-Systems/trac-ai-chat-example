import {getStorePath} from './src/functions.js';
import {App} from './src/app.js';
export * from 'trac-peer/src/functions.js'
import {default as AiChatProtocol} from "./contract/protocol.js";
import {default as AiChatContract} from "./contract/contract.js";
import {Timer} from "./features/timer/index.js";
import {AiOracle} from "./features/ai/index.js";

console.log('Storage path:', getStorePath());

///// MSB SETUP
// To run this example, you don't need to create your own MSB
// Instead go with the options as-is. The below bootstrap is an MSB testnet (gasless).
const msb_opts = {};
msb_opts.bootstrap = 'a4951e5f744e2a9ceeb875a7965762481dab0a7bb0531a71568e34bf7abd2c53';
msb_opts.channel = '0002tracnetworkmainsettlementbus';
msb_opts.store_name = getStorePath() + '/msb';

///// SAMPLE CONTRACT SETUP
// The sample contract needs to be deployed first.
// See the README.md for further information.
const peer_opts = {};
peer_opts.protocol = AiChatProtocol;
peer_opts.contract = AiChatContract;
peer_opts.bootstrap = '51d7495213cff2305dda0629c7b80310455a13165b4e8ac029a3f425c7e83f3e';
peer_opts.channel = '00000000000000000000000000aichat';
peer_opts.store_name = getStorePath() + '/aichat';
peer_opts.api_tx_exposed = true;
peer_opts.api_msg_exposed = true;

///// FEATURES
// Pass multiple features (aka oracles) to the peer and inject data into
// your contract. Can also go the other way, depending on how you need it.
// You may add as many Features as you wish.
// In /src/app.js, the Features are being executed by the admin (usually the Peer Bootstrap)
const timer_opts = {};
// Tighter interval for rate limiter precision
timer_opts.update_interval = 1_000;

const ai_opts = {};
ai_opts.endpoint = 'http://127.0.0.1:8000/v1/chat/completions';
ai_opts.model = 'gpt-oss-120b-fp16';
ai_opts.max_context_tokens = 32768;
ai_opts.max_reply_tokens = 1024;
ai_opts.poll_interval_ms = 1000;
ai_opts.history_window = 32; // include last 32 Q/A turns (trimmed to token budget)
// Auth config for local vLLM server
ai_opts.api_key = 'local-qwen3'; // Authorization: Bearer local-qwen3

export const app = new App(msb_opts, peer_opts, [
    {
        name : 'timer',
        class : Timer,
        opts : timer_opts
    },
    {
        name : 'ai',
        class : AiOracle,
        opts : ai_opts
    }
]);
await app.start();
