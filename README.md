# BC Developer's Toolset

## Introduction

The purpose of this toolset is the management of development environments for Business Central projects. The goal is to make quick work of preparation of local Docker repositories, as well as other routinely executed management procedures, such as editing of *launch.json*.

It doesn't have an output or an artifact. The solution is the repository itself, with its ability to be integrated into projects. You could sever its tie to the origin by deleting the .git folder, but that would prevent it from keeping itself up to date. It's a simple, no brainer approach that might get more sophisticated in the future, but will always focus on simplicity.

This toolset is a work in continuous progress. Any usage is subject to a MIT license as specified in the repository.

If you want to reach out to the developer, please open an issue at the *[BC-Dev-Toolset](https://github.com/dam-pav/BC-Dev-Toolset/issues)*. You are also welcome to apply as contributor.

## **Starting a new workspace**

Starting a new workspace and including the toolset is easy.

1. Define a *?repository?.code-workspace* file (replace *?repository?* with a proper name). The name of the repository will become the default name for your Docker container.
2. Acquire a clone of the BC-Dev-Toolset repository. ***You can copy an existing folder from existing workspaces from your other projects.*** Technically, cloning is nothing more than making a copy, so any source will do, as long it includes the *.git* folder. The name of the toolset folder is not important, but *BC-Dev-Toolset* is a good name. Add this folder to the workspace.
3. Make sure this folder is ignored by git by specifying it in *.gitignore* in the root of your workspace. For example, if the name of the toolset folder is *BC-Dev-Toolset*, add a line to *.gitignore*:
   **`BC-Dev-Toolset/`**
   If, on the contrary, you intend to include the toolset into your repository, do not exclude it from git. This will cause changes to your main repository with every update to the toolset. If you want to also prevent updates from the origin, remove the *.git* folder.
4. Delete or edit the preexisting *settings.json*. If you delete it, it will be recreated with default values when you run any script.
5. Delete or edit the preexisting *visualization\data.json*. If you delete it, it will be recreated with default values when you run *visualization\\DataUpdate.ps1*.
6. You can create your first Docker container now by running *NewDockerContainer.ps1*.

## Toolset scripts

* ***CreateRuntimePackage.ps1***: creates Runtime packages, using the local Docker instance.
* ***NewDockerContainer.ps1***: creates a Docker container with a Sandbox BC platform version determined by the first app.json found. If a previous container with the same name is found, it gets removed and replaced. Doesn't support multiplatform (apps for different platform versions) projects.
* ***PublishApps2Docker.ps1***: publish apps as PTE (as opposed to Dev) to the locally created Docker instance.
* ***PublishApps2Test.ps1***: publish apps as PTE (as opposed to Dev) to the remote servers specified in *settings.json*, with the *targetType* value of *Test*.
* ***PublishRuntimeApps2Docker.ps1***: publish *runtime* apps as PTE to the locally created Docker instance.
* ***PublishRuntimeApps2Test.ps1***: publish *runtime* apps as PTE to the remote servers specified in *settings.json*, with the *targetType* value of *Test*.
* ***UnpublishDockerApps.ps1***: unpublish all the apps in the workspace from the locally created Docker instance.
* ***UnpublishTestApps.ps1***: unpublish all the apps in the workspace from the remote servers specified in *settings.json*, with the *targetType* value of *Test*.
* ***UpdateLaunchJson.ps1***: creates or/and updates *launch.json* configurations for all apps in the workspace. It takes care of default local configuration for Docker and, in addition, for all remote configurations defined in *settings.json*.
* The ***visualisation*** subfolder contains additional scripting:
  * ***DataUpdate.ps1***: collects and updates the data.json. *data.json* currently contains all the ranges from all the apps in the workspace.
  * ***WorkspaceAnalysis.html***: currently contains a visual mapping of the ranges collected in *data.json*. It will not function as a HTML preview, because it runs jscript. To view the page, use the VSCode extension, "Live Server".
* The ***common*** subfolder contains scripts with helper functions. Not to be run directly.

## Settings

Use *settings.json* to configure the scripts behaviour. If not found, a *settings.json* file will be created for you when any of the scripts is first run, with default values.

* ***authentication***: Specifies the authentication mode for the Docker instance. Default value is *UserPassword*.
* ***admin*** and ***password***: The default user for the Docker BC instance.
* ***containerName***: The name for the Docker container. The default value is the name of the workspace.
* ***environmentType***: Type of BC instance to create. Valid values are *Sandbox* or *OnPrem*. Default value is *Sandbox*.
* ***country***: sets the platform country version. Default values is "w1".
* ***licenseFile***: Specify if you have one. Mandatory for Runtime packages.
* ***certificateFile***: Specify if you have one. Mandatory for Runtime packages.
* ***packageOutputPath***: Specify a specific folder path to group the Runtime packages. If empty, a runtime subfolder will automatically be created and used in the project. Remember to use double backslashes for full paths. For instance, for an actual path of "c:\\project\\packages" you will need to use "c:\\\\project\\\packages\".
* ***remoteConfigurations***: Specify a list of remote deployments. Valid attributes (a subset of attributes for ***configurations*** in *launch.json*):
  * ***name***: a distinctive name for the configuration. The actual name will be composed of this and of the value of ***environmentType***. This value is mandatory; the list entry will be ignored if ***name*** has an empty value.
  * ***serverType***: Accepted values are *Cloud*, *SelfHosted* or *OnPrem*. Mandatory.
  * ***targetType***: Accepted values are *Test*, *Production*.
  * ***server***: Valid for server types SelfHosted or OnPrem.
  * ***serverInstance***: Valid for OnPrem.
  * ***port***: Valid for OnPrem.
  * ***environmentName***: Valid for Cloud or SelfHosted.
  * ***tenant***: Valid for Cloud or OnPrem.
  * ***authentication***: Valid for OnPrem.
