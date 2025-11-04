# Trac AI Chat (P2P)

This app runs a P2P chat contract where a single shared AI agent responds publicly when tagged with `@ai`. The AI is backed by a local REST model endpoint at the bootstrap's Oracle (Chat Completions API). The contract enforces ordered processing of messages and per-user rate limits.

## Requirements

Mac/Linux/Windows, Node.js 22+, Git.

Quick per‑OS setup:

macOS
- Install Xcode Command Line Tools: `xcode-select --install`
- Install Node.js 22 (pick one):
  - Homebrew: `brew install node@22 && echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc`
  - NVM: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash` then `nvm install 22 && nvm use 22`
- Install Git: `brew install git` (Git may already be available)

Ubuntu/Debian
- Tools: `sudo apt update && sudo apt install -y git curl build-essential`
- Install Node.js 22 (pick one):
  - NodeSource: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs`
  - NVM: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash` then `nvm install 22 && nvm use 22`

Fedora/CentOS/RHEL
- Tools: `sudo dnf install -y git gcc-c++ make curl`
- Install Node.js 22 (pick one):
  - NVM: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash` then `nvm install 22 && nvm use 22`

Windows 10/11
- Git: `winget install Git.Git` (or install from git-scm.com)
- Node.js 22 (pick one):
  - NVM for Windows: `winget install CoreyButler.NVMforWindows`, then run `nvm install 22` and `nvm use 22`
  - Installer from nodejs.org (Current 22.x)
- Optional build tools (only if native modules need to compile): `winget install Microsoft.VisualStudio.2022.BuildTools` and select C++ build tools

 
## Install

Clone the repo, change into it, then install the CLI and deps:

```sh
git clone https://github.com/Trac-Systems/trac-ai-chat-example.git
cd trac-ai-chat-example

# Install Pear (App3 runtime) globally
npm install -g pear

# Install project dependencies
npm install
```

## Run

```sh
pear run . store1
```

## How to chat

Wait for the terminal/app to fully load before you try prompting (may take a while).

In the terminal type your message like this:

```sh
/post --message "hi"
```

To talk to the ai directly, tag it with @ai:

```sh
/post --message "@ai hi"
```

The ai will tag your with your nickname or your publickey if the nickname isn't set yet.

To change your nickname, do this:

```sh
/set_nick --nick "Peter"
```

## Custom Setup (advanced)

1) Bootstrap an MSB and Peer per Trac docs. In `index.js`, set the Peer `bootstrap` and `channel` for your contract. The MSB config points to a public testnet by default.

2) Run the app, choose a wallet seed (interactive), then add yourself as admin in the terminal:

```
/add_admin --address <YourPeerWriterAddress>
```

3) Ensure chat is enabled and, if desired, auto-add writers:

```
/set_chat --enabled 1
/set_auto_add_writers --enabled 1
```

4) Start your local model API e.g. at `http://127.0.0.1:8000/v1/chat/completions`.

5) Use the terminal chat; mention `@ai` followed by your prompt. The AI will reply in public if you’re within rate limits.
