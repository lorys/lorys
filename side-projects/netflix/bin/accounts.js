// Manage the encrypted accounts file (ACCOUNTS_PATH, key from ACCOUNTS_SECRET).
//
//   npm run accounts -- add <username> <password>
//   npm run accounts -- remove <username>
//   npm run accounts -- list
//   npm run accounts -- import <plain.json>   # [{ "username", "password" }] → encrypted
//   npm run accounts -- export                # print decrypted JSON
import fs from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { hashPassword, readAccounts, writeAccounts } from '../src/accounts.js';

const { accountsPath, accountsSecret } = loadConfig();
const [command, ...args] = process.argv.slice(2);

function usage() {
  console.error('Usage: accounts <add <username> <password> | remove <username> | list | import <file.json> | export>');
  process.exit(1);
}

const accounts = await readAccounts(accountsPath, accountsSecret);

switch (command) {
  case 'add': {
    const [username, password] = args;
    if (!username || !password) usage();
    const index = accounts.findIndex((a) => a.username === username);
    // Changing the password keeps the user's watch progress.
    if (index === -1) accounts.push({ username, password: hashPassword(password) });
    else accounts[index].password = hashPassword(password);
    await writeAccounts(accountsPath, accounts, accountsSecret);
    console.log(`${index === -1 ? 'Compte créé' : 'Mot de passe mis à jour'} : ${username}`);
    break;
  }
  case 'remove': {
    const [username] = args;
    if (!username) usage();
    const remaining = accounts.filter((a) => a.username !== username);
    if (remaining.length === accounts.length) {
      console.error(`Compte inconnu : ${username}`);
      process.exit(1);
    }
    await writeAccounts(accountsPath, remaining, accountsSecret);
    console.log(`Compte supprimé : ${username}`);
    break;
  }
  case 'list':
    for (const a of accounts) console.log(a.username);
    break;
  case 'import': {
    const [file] = args;
    if (!file) usage();
    const imported = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(imported) || !imported.every((a) => typeof a.username === 'string' && typeof a.password === 'string')) {
      console.error('Le fichier doit contenir un tableau [{ "username": string, "password": string }]');
      process.exit(1);
    }
    await writeAccounts(accountsPath, imported, accountsSecret);
    console.log(`${imported.length} compte(s) importé(s) dans ${accountsPath}`);
    break;
  }
  case 'export':
    console.log(JSON.stringify(accounts, null, 2));
    break;
  default:
    usage();
}
