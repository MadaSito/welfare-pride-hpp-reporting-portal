# Install the Welfare Pride portal on Hostinger using GitHub

This guide is for Hostinger’s **managed Node.js Web App / GitHub import** option, not its VPS command-line deployment. It is a **test deployment guide**, not production approval. The current portal does not encrypt its entire SQLite database, some integration secrets are stored in plaintext, Entra SSO is not implemented, and other security findings remain open. Do not use real or sensitive data until those issues are resolved and independently reviewed. The Hostinger installation has not yet been tested on your particular plan.

## 1. Confirm the prerequisites

1. Confirm that your plan supports Node.js Web Apps. Hostinger lists Business Web Hosting and supported Cloud plans for its hPanel flow. [1]
2. Confirm you can connect to your hosting account using an interactive SSH terminal. You will need this to create the first administrator. [2]
3. Ask Hostinger to confirm an **absolute, private, writable, persistent directory outside both the web root and deployment/build folders**. Confirm it survives redeploys, that the Node.js process and your SSH account can access it, and that appropriate encrypted backups can be made. Do not proceed with business data based on an unverified path. Hostinger manages and replaces files in its deployment folders. [3]
4. Choose a domain or subdomain with HTTPS enabled. Use one canonical address; the application's login checks the exact origin.

## 2. Connect the private GitHub repository

1. Sign in to Hostinger hPanel. Open **Websites** and choose **Create site** or **Add Website**.
2. Choose **Web App / Node.js web app**, then **Import Git Repository** or **Connect with GitHub**. Names can vary slightly in hPanel. [1]
3. Authorize Hostinger’s GitHub app for this specific private repository:

   [MadaSito/welfare-pride-hpp-reporting-portal](https://github.com/MadaSito/welfare-pride-hpp-reporting-portal)

4. Select the repository and its **main** branch. If it is not listed, check the GitHub app's repository permissions and refresh Hostinger’s repository list. Do not make the repository public merely to deploy it.

## 3. Review the build settings

Choose the **Express.js** server preset, not a static React/Vite deployment. The React frontend and API are served together by the Node.js process. Hostinger’s entry file for Express is relative to the repository root. [4]

- **Root directory:** repository root (`/` or blank).
- **Branch:** `main`.
- **Node.js:** select **22.x** (recommended, tested). Node **24.x** is also compatible (the application declares `node >=22` and its native modules support it), but 22.x is the LTS line the portal was built and verified against. [5]
- **Package manager:** `pnpm`; the repository declares pnpm `10.4.1` and contains `pnpm-lock.yaml`. Hostinger documents automatic pnpm detection. [6]
- **Build script:** select `build`; if the field asks for a shell command, use `pnpm run build`.
- **Entry file:** `dist/index.js`.
- **Output directory:** leave blank for the Express preset. Do not deploy `dist/public` as a static site: it would omit the API and server. The complete project, including runtime dependencies and the root `branding` folder, needs to remain available.
- **Start command, if the panel separately asks for one:** `pnpm start` or `node dist/index.js`.

The build needs development dependencies including Vite and esbuild. The initial-admin command also needs `tsx` and the `server/` source files. If Hostinger omits those dependencies or files from the deployed installation, the normal build or administrator setup may fail; check the build logs and ask Hostinger how its build and runtime environments expose them. Native packages also need compatible Linux/Node binaries. This workflow has not yet been verified on the target host.

A clean, isolated local checkout at commit `bf09c00` successfully installed and built with Node 22.23.4 and pnpm 10.4.1. Its SQLite and password-hashing native-module smoke tests also passed. This is useful preflight evidence, not proof that Hostinger uses the same environment or will retain the files needed for bootstrap.

## 4. Add environment variables

At **Review build settings → Environment variables → Edit**, add the following. Hostinger provides an **Add more** option for variables it did not detect. [7]

```text
NODE_ENV=production
APP_ORIGIN=https://your-reporting-domain.example
APP_SESSION_SECRET=<your unique random session secret>
APP_ENCRYPTION_KEY=<your unique base64-encoded 32-byte encryption key>
DATA_DIR=/absolute/hostinger-confirmed/private/persistent/directory
```

Replace each placeholder; the lines above are not usable values. `APP_ORIGIN` must exactly match the HTTPS address used in the browser, with **no path or trailing slash**. Do not set `SQLITE_PATH` unless you intentionally configure a separate absolute database path; otherwise the database is `DATA_DIR/portal.db`. Let Hostinger provide `PORT` unless its panel instructs otherwise. Environment variables configured in hPanel are separate from GitHub. A `.env` file by itself is not automatically loaded by these application commands.

Generate two different values privately on a trusted computer with Node.js installed:

```sh
# Run once for APP_SESSION_SECRET; copy the output privately into hPanel.
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Run separately for APP_ENCRYPTION_KEY; copy the output privately into hPanel.
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Store both in an approved secret manager and back up the encryption key securely and separately. Do not commit them, send them in chat, or paste them into support tickets. Preserve the encryption key across redeployments; changing or losing it can make existing MFA secrets unreadable. These keys **do not encrypt the entire database**.

## 5. Deploy and check the build

Click **Deploy**. Watch **Deployments → Build logs**. After a successful build, check the application’s **Runtime Logs** as well; a green build does not guarantee that the Node.js process started. [1]

Before creating the administrator, verify the deployed application responds at `https://your-reporting-domain.example/healthz`. The response should contain `"ok":true`. Confirm that the process uses the exact `DATA_DIR` you configured and that it is not inside `public_html` or `hbuilds`. Never copy secrets or SQLite files into a served or redeployed folder.

## 6. Create the first administrator

There is **no standard default password**. On a new, empty database, open the site in your browser — the sign-in page detects that no accounts exist and automatically presents a **first-time setup wizard**:

1. Open `https://your-reporting-domain.example` in a private/incognito window.
2. Enter your administrator email and a strong password (14+ characters, upper/lower, at least 2 numbers, 3 special characters).
3. Optionally expand **Customize branding** to set your company name, tagline, brand colors (multiple hex values) and logo URL.
4. Click **Create administrator account**. The super administrator is created locally in the database — **no email access and no SSH required**.
5. Continue immediately into MFA enrollment (scan the QR code with your authenticator app, save the recovery codes), then into the dashboard.

The setup wizard runs **exactly once**. Afterward, every visitor only ever sees the standard sign-in page.

### Alternative (CLI, optional)

Operators with an interactive SSH terminal can instead run the bootstrap command. It creates the super administrator only when no users exist, generates a random temporary password shown once on that terminal, and also requires MFA enrollment on first sign-in:

```sh
cd ~/domains/your-reporting-domain.example/hbuilds/current/nodejs
export DATA_DIR=/absolute/hostinger-confirmed/private/persistent/directory
node --import tsx server/bootstrap-admin.ts --email administrator@example.org
```

The Hostinger database is separate from any preview database; credentials and reports are not automatically transferred.

If the database already contains accounts, **do not delete it or rerun bootstrap to regain access**. There is no completed self-service recovery procedure for existing accounts. Preserve the data and arrange an authorized, verified recovery procedure.

## 7. Email and future updates

Password sign-in is the initial access method. Email links require an active local account with MFA already enrolled, an enabled and configured SMTP or Microsoft Graph email provider, the correct HTTPS origin, and no global BCC. Open the link in the same browser that requested it, then complete MFA. SSO is currently unavailable.

Hostinger says a push to the connected branch can trigger a rebuild automatically. Before using that feature, verify that persistent data and keys survive a redeployment; never store the SQLite database or backups in `hbuilds` or `public_html`. Take an independently verified, SQLite-consistent encrypted backup before changes; the portal’s own backup and restore features are not production-ready. [1] [3]

If the app fails, check Hostinger’s build and runtime logs for missing development dependencies, native module errors, missing variables, file permissions or an incorrect entry file. Do not post log lines containing secrets or personal information. A working deployment or green health check does not resolve the security blockers.

### Common build errors

- **`ERROR: Entry file not found`** — the build succeeded but Hostinger’s **Entry file** field doesn’t match the file that was produced. Fix: go to **Deployments → Settings & Redeploy**, verify the framework is **Express**, and set **Entry file** to `dist/index.js` (or `index.js` / `server.js` with the updated repository). Leave the **Output directory** field empty. Then click **Save and Redeploy**.

## References

[1]: https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/ "Hostinger: add a Node.js web app"
[2]: https://www.hostinger.com/support/1583245-how-to-connect-to-a-hosting-plan-via-ssh-in-hostinger/ "Hostinger: connect to a hosting plan via SSH"
[3]: https://docs.hostinger.com/node.js/file-structure "Hostinger: Node.js file structure"
[4]: https://docs.hostinger.com/node.js/build-settings "Hostinger: Node.js build settings"
[5]: https://www.hostinger.com/support/how-to-select-the-node-js-version-for-your-application/ "Hostinger: select a Node.js version"
[6]: https://www.hostinger.com/support/how-to-deploy-monorepos-with-npm-yarn-or-pnpm-on-hostinger/ "Hostinger: npm, yarn and pnpm deployment"
[7]: https://www.hostinger.com/support/how-to-add-environment-variables-during-node-js-application-deployment/ "Hostinger: add environment variables"
