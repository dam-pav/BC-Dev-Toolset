# Business Central Developer's Toolset

## Introduction

The purpose of this toolset is the management of development environments for Business Central projects. The goal is to make quick work of preparation of local Docker repositories, as well as other routinely executed management procedures, such as editing of *launch.json*. It's a simple, no brainer approach that might get more sophisticated in the future, but will always focus on simplicity.

It relies on information about your project/app that is already available from *app.json* or *repo.code-workspace*. Only information that is not already there needs to be added to toolset's own settings. Part of the toolset's setting are developer's own preferences, while other, such as the locations of test environments, can be made available from within the repository, so that developers don't have to manage those manually.

It doesn't have an output or an artifact. The solution is the repository itself, with its ability to be integrated into projects. You can sever its tie to the origin by deleting the .git folder - that will prevent it from keeping itself up to date if that is what you want.

This toolset is a work in continuous progress. Any usage is subject to a MIT license as specified in the repository.

If you want to reach out to the developer, please open an issue at *[BC-Dev-Toolset](https://github.com/dam-pav/BC-Dev-Toolset/issues)*. You are also welcome to apply as contributor.

## Prerequisites

1. A **Windows Pro** or **Windows Enterprise** edition.
   Unfortunately, Docker Desktop doesn't allow Windows containers on Windows Home. If you don't have access to any of the above, you won't be able to develop for BC using Docker.
2. **Docker Desktop**.

   ```
   winget install -e --id Docker.DockerDesktop
   ```

   You will need to switch to Windows containers. In order to do that, running this in a PowerShell prompt might help:

   ```
   & $Env:ProgramFiles\Docker\Docker\DockerCli.exe -SwitchDaemon
   ```
3. **GIT**.
   You will need CLI for git. A good way to install it on a Windows PC is using WinGet:

   ```
   winget install -e --id Git.Git
   ```

   After the installation is done, close your PS terminal sessions and start a new to get access to git.
4. **VS Code**.

   ```
   winget install -e --id Microsoft.VisualStudioCode
   ```

## **Starting a new workspace**

Starting a new workspace and including the toolset is easy.

1. Define a *repository.code-workspace* file (replace *repository* with a proper name). The name of the repository will become the default name for your Docker container. Your repository might already include such a file.
2. Acquire a clone of the BC-Dev-Toolset repository.

   1. The easiest way is to get ***[initBCDevToolset.ps1](https://github.com/dam-pav/BC-Dev-Toolset/blob/main/common/initBCDevToolset.ps1)***, save it to the root of your repository (beside the *code-workspace* file) and run it with Powershell. This script executes substeps *ii* through *iv* for you. You might run into some trouble with the execution policy, since the script is not digitally signed (might happen in near future). In such event please bypass the policy by running:

      ```
      Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
      ```

      After this the script will run. Once you close the PS session (process is the scope), the bypass is gone.
   2. The slightly longer approach would be to select the root folder for your repository, then execute this command line:

      ```
      git clone https://github.com/dam-pav/BC-Dev-Toolset.git
      ```

      If you accidentally cloned the toolset into somewhere else, there is nothing to worry about. Just move the folder where you need it. ***You can copy an existing folder from existing workspaces from your other projects.*** Technically, cloning is nothing more than making a copy, so any source will do, as long it includes the *.git* folder. The name of the toolset folder is not important, but *BC-Dev-Toolset* is a good name. Add this folder to the workspace (see Setup).
   3. Make sure this folder is ignored by git by specifying it in *.gitignore* in the root of your workspace. For example, if the name of the toolset folder is *BC-Dev-Toolset*, add a line to *.gitignore*:
      **`BC-Dev-Toolset/`**
      If, on the contrary, you intend to include the toolset into your repository, do not exclude it from git. This will cause changes to your main repository with every update to the toolset. You can prevent updates from the origin by removing the contained *.git* folder.
   4. It is also recommended to add **`launch.json`** to *.gitignore*. These files are personalized per developer and managed by the toolset.
3. Delete or edit the preexisting *settings.json*. If you delete it, it will be recreated with default values when you run any script.
4. Delete or edit the preexisting *visualization\data.json*. If you delete it, it will be recreated with default values when you run *visualization\\DataUpdate.ps1*.
5. You can create your first Docker container now by running ***NewDockerContainer.ps1***.

## Toolset scripts

* ***CreateRuntimePackage.ps1***: creates Runtime packages, using the local Docker instance.
* ***NewDockerContainer.ps1***: creates a Docker container with a Sandbox BC platform version determined by the first app.json found. If an existing container with the same name is found, it gets removed and replaced. Doesn't support multiplatform (apps for different platform versions) projects.
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

## Setup

### *.gitignore*

Add these two lines to the .gitignore file in the root of your repository:

```
BC-Dev-Toolset/
launch.json
```

You might have already initialized git with these folders and files. In that case mere modification of *.gitignore* will not suffice. You will need to run

```
git rm BC-Dev-Toolset -r -f
```

in order to remove the folder and the containing files from git. This doesn't delete the files, just the tracking. Also, you might also need to run

```
git rm */launch.json --cached
```

to remove the files from git. You will need to commit these changes.

### *repository*.code-workspace

*.code-workspace is a configuration file for VSCode. For instance:

```
{
  "folders": [
    {
      "path": "App"
    },
	{
      "path": "BC-Dev-Toolset"
    }
  ],
  "settings": {
    "liveServer.settings.multiRootWorkspaceName": "BC-Dev-Toolset",
    "powershell.cwd": "BC-Dev-Toolset",
    "bcdevtoolset": {
      "country": "w1",
      "remoteConfigurations":  [
        {
          "name": "Test environment",
                  "serverType": "Cloud",
                  "environmentName": "TEST",
                  "tenant": "tenants-guid-comes-here"
        }
      ]
    }
  }
}

```

Its most obvious role is to define the folders included in the workspace. In addition to folders containing separate apps we need to make sure one additional folder, containing the toolset, is also included.

We also use it as a vessel to carry configuration relevant to the workspace. The root attribute ***bcdevtoolset*** can specify:

* ***country***: optional, sets the platform country version. The default is "w1".
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

### *settings.json*

Use *settings.json* to personalize your scripts behaviour. If not found, a *settings.json* file will be created for you when any of the scripts is first run, with default values.

* ***authentication***: Specifies the authentication mode for the Docker instance. Default value is *UserPassword*.
* ***admin*** and ***password***: The default user for the Docker BC instance.
* ***containerName***: The name for the Docker container. The default value is the name of the workspace.
* ***environmentType***: Type of BC instance to create. Valid values are *Sandbox* or *OnPrem*. Default value is *Sandbox*.
* ***licenseFile***: Specify if you have one. Mandatory for Runtime packages.
* ***certificateFile***: Specify if you have one. Mandatory for Runtime packages.
* ***packageOutputPath***: Specify a specific folder path to group the Runtime packages. If empty, a runtime subfolder will automatically be created and used in the project. Remember to use double backslashes for full paths. For instance, for an actual path of "c:\\project\\packages" you will need to use "c:\\\\project\\\packages\".
* ***remoteConfigurations***: Personalize an additional list of remote deployments. Valid attributes (a subset of attributes for ***configurations*** in *launch.json*). Same structure as defined for *.code-workspace*.
