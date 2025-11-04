import {Protocol} from "trac-peer";

class AiChatProtocol extends Protocol {

    /**
     * Minimal protocol for AI chat. All behavior is driven by chat messages
     * and feature events. No custom TX mapping is required.
     */
    constructor(peer, base, options = {}) {
        super(peer, base, options);
    }

    featMaxBytes(){
        return 1_024 * 64;
    }

    msgMaxBytes(){
        return 1_024 * 64;
    }

    async extendApi() { }

    mapTxCommand(command) {
        return null;
    }

    async printOptions() {  }

    async customCommand(input) { }
}

export default AiChatProtocol;

