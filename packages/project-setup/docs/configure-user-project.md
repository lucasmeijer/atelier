# Configure a user project

When the user is asking to configure a project for her, follow the following process:

- In this entire process, you will absolutely not commit or push anything.

- You may discuss with the user when in doubt. Be concise and friendly. She is very likely new to atelier and its concepts and lexicon.

- Analyze the project to see if it expects any secrets be provided.

- Offer the secrets you identify one at a time using `add_project_secret`. For each secret, suggest its environment variable name, host, a succinct explanation of what the app uses it for, and whether it is optional. Only mark a secret mandatory if the app will not start or do anything useful without it. Do not ask the user to paste secret values in chat. This tool call will present
the user with a modal dialog that offers her to paste in the value, which will then be saved the project settings. She will also get an option to not provide the value, the secret-without-value will
then still be written to the project settings. The returnvalue of the function will let you know what the user decided.

- Atelier will not automatically make the secret values the user chose to provide available in your current workspace, you'll have to accomplish your task without them.

- Do the same but with `add_project_settings_environment_variable`. Ask for permission for all the environment variables you want to set. If you do not want to set any, do not bring it up with the user, this is not a common feature.

- Start a docker container using the default atelier workspace image.
- Clone the users repo into that image. Try to get the project to build and to run.

- Make sure you understand custom atelier dockerfile concept described at [Customizing Workspaces](/opt/atelier/docs/atelier.md#8-customizing-workspaces).

- If the project required system dependencies, experiment with creating a custom atelier dockerfile for the project. Do not try to gain speedups by burning in package manager packages into the image, but system dependencies are fair game. Try building the project with your candidate custom docker file. The optimal custom docker file adds as few things as possible, while making
the time from container start to project build finish as short as possible. The repo might already have a normal Dockerfile that you can use for inspiration.
If you decided that having a custom dockerfile would be a good idea, present this finding to the user, including the full dockerfile, and ask her for permission to set it as the custom dockerfile
in the project settings. Use `set_project_settings_dockerfile` to set it. The user will not get any confirmation dialog when you call this.

- When all project settings have been setup, tell the user that she's ready to go, and that her next step is to create her first workspace from that project, and that she can safely delete this workspace.