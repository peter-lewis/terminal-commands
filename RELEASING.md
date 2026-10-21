# Releasing

Terminal Commands is published to the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=peter-lewis.vscode-terminal-commands), which VS Code uses, and to [Open VSX](https://open-vsx.org/extension/peter-lewis/vscode-terminal-commands), which Cursor and other editors that can't use Microsoft's marketplace use.

Pushing a version tag runs the [Release workflow](.github/workflows/release.yml). It:

1. checks that the tag matches the version in `package.json`, runs all the tests, and packages the `.vsix`;
2. creates a GitHub release with the `.vsix`, with this version's section of `CHANGELOG.md` as the release notes;
3. publishes to Open VSX;
4. publishes to the Marketplace, once [publishing from the workflow](#publishing-to-the-marketplace-from-the-workflow) is set up. Until then, upload the `.vsix` by hand.

## Making a release

1. Update `version` in `package.json`.
2. In `CHANGELOG.md`, rename `## Unreleased` to the version, e.g. `## 0.2.0`.
3. Commit and push, and wait for CI to pass.
4. Tag the commit and push the tag:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

5. If the Marketplace job didn't run, download the `.vsix` from the GitHub release, and upload it on the [publisher management page](https://marketplace.visualstudio.com/manage): **...** > **Update** next to the extension.

A publishing job that failed can be re-run once the cause is fixed. It skips versions that are already published.

## One-time setup

The repository must be public, because the stores load the README's images from GitHub.

### Visual Studio Marketplace

1. Sign in to the [publisher management page](https://marketplace.visualstudio.com/manage) with a Microsoft account, and create a publisher with the ID `peter-lewis`, the `publisher` in `package.json`. If that ID is taken, choose another, and replace `peter-lewis.vscode-terminal-commands` and the store links throughout the repository to match.
2. Publish the first version by hand: choose **New extension** > **Visual Studio Code**, and upload the `.vsix` from the GitHub release, or one built with `pnpm run package`.

### Open VSX

1. Create an [Eclipse Foundation account](https://accounts.eclipse.org/user/register), and fill in your GitHub username.
2. Sign in to [open-vsx.org](https://open-vsx.org) with GitHub. Open **Settings** from your avatar, click **Log in with Eclipse**, and sign the Publisher Agreement.
3. Under **Settings** > **Access Tokens**, generate a token. Create the namespace with it:

   ```sh
   pnpm exec ovsx create-namespace peter-lewis -p <token>
   ```

4. In the repository's settings on GitHub, add the token as an Actions secret named `OVSX_PAT`. The Release workflow publishes with it.

Once the first version is out, you can switch to [trusted publishing](https://github.com/eclipse/openvsx/wiki/Trusted-Publishing), which needs no stored token. On open-vsx.org, under **Settings** > **Trusted Publishers**, add a GitHub Actions publisher for `peter-lewis/vscode-terminal-commands` with the workflow `release.yml` and the environment `release`. Then delete the `OVSX_PAT` secret.

To have the extension shown as verified, [claim the namespace](https://github.com/eclipse/openvsx/wiki/Namespace-Access).

### Publishing to the Marketplace from the workflow

Personal access tokens for the Marketplace stop working on December 1, 2026, when Azure DevOps retires them (see [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)). Instead, the workflow signs in to Microsoft Entra ID as an app, through GitHub's OIDC, so there is no secret to store. To set that up:

1. In the [Microsoft Entra admin center](https://entra.microsoft.com), register an application. Note its application (client) ID and directory (tenant) ID. An app registration doesn't need an Azure subscription.
2. In the app's **Certificates & secrets** > **Federated credentials**, add a credential for the scenario **GitHub Actions deploying Azure resources**: organization `peter-lewis`, repository `vscode-terminal-commands`, entity type **Environment**, environment `release`.
3. In the repository's settings on GitHub, add the Actions variables `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`. Add them to the repository, not to the `release` environment: the workflow checks them to decide whether to run the Marketplace job.
4. Push a release tag. The Marketplace job's **Show the identity's Marketplace ID** step prints an ID. Publishing fails, because that identity can't publish yet.
5. On the [publisher management page](https://marketplace.visualstudio.com/manage), add that ID to the publisher's members with the **Contributor** role. Then re-run the failed job.

The `release` environment is created the first time the workflow runs. In **Settings** > **Environments** you can add protection rules to it, such as a required reviewer before anything is published.

## Publishing by hand

```sh
pnpm run package
pnpm exec ovsx publish vscode-terminal-commands-<version>.vsix -p <token>
```

Then upload the `.vsix` to the Marketplace as described above.
