# Security

Please don't open a public issue for a security problem. Report it privately through GitHub:
**Security → Report a vulnerability** on this repository.

Worth reporting: anything that could leak a viewer's Stremio `authKey`, run script from addon or
trailer data, or expose the TV or the streaming server beyond the local network.

How Nova handles data: the Stremio `authKey` is kept in the TV app's local storage and sent only
to `api.strem.io`. Nova has no server of its own. The trailer relay page (`trailer-relay/`)
receives nothing but a YouTube video id.
