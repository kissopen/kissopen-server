# KissOpen standalone relay runtime

The packaging shell for `../kissopen-server`. Build from the workspace root;
the bundle and Prisma migrations are generated locally. No client repository is
required and no web/mobile build is automatically included.

After `pnpm build`, run the CLI with `migrate` and `serve`, supplying private
environment settings as documented in `../../docs/self-hosting.md`. Do not
run migrations against a deployed database without its owner's approval and
a restorable backup. Upstream MIT attribution is preserved in LICENSE.
