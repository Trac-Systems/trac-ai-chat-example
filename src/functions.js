/** @typedef {import('pear-interface')} */
export function getStorePath(){
    let store_path = '';

    // Prefer Pear desktop/runtime args if available (desktop mode)
    try {
        const pear = (typeof global !== 'undefined' && global.Pear)
            || (typeof globalThis !== 'undefined' && globalThis.Pear)
            || (typeof window !== 'undefined' && window.Pear);
        if (pear && pear.config) {
            const pearArgs = Array.isArray(pear.config.args) ? pear.config.args : [];
            if (pearArgs.length > 0 && typeof pearArgs[0] === 'string' && pearArgs[0] !== '') {
                store_path = pearArgs[0];
            } else if (typeof pear.config.storage === 'string' && pear.config.storage !== '') {
                store_path = pear.config.storage;
            }
        }
    } catch(_) {}

    // Fallback to process argv (terminal mode)
    if(store_path === '' && typeof process !== "undefined" && Array.isArray(process.argv)) {
        // Legacy Pear JSON injection (keep for compatibility if present)
        try {
            if(process.argv[27] !== undefined){
                const args = JSON.parse(process.argv[27]);
                if(args && args.flags && typeof args.flags.store === 'string' && args.flags.store !== ''){
                    store_path = args.flags.store;
                }
            }
        } catch(_) {}

        // Explicit user data dir flag anywhere in argv
        if(store_path === ''){
            const ud = process.argv.find(a => typeof a === 'string' && a.startsWith('--user-data-dir='));
            if(ud){
                store_path = ud.split('=')[1];
            }
        }

        // Positional arg (scan from end to catch desktop args positioning)
        if(store_path === ''){
            for (let i = process.argv.length - 1; i >= 2; i--) {
                const a = process.argv[i];
                if (typeof a === 'string' && a !== '' && a[0] !== '-') { store_path = a; break; }
            }
        }
    }

    if(store_path === ''){
        throw new Error('No store path given.');
    }
    return store_path;
}
