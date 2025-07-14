# Business Central Developer's Toolset

## Why?

If you are a BC developer, you might have to spend an inordinate amount of time manually executing operations such as preparing your development tools and set up, preparing and deploying packages and so on. I'm sure you'd rather spend that time doing something less dull and repetitive.

The things that the toolset will enable you to do once it is set up:

* Creating exactly the containers your app needs based on what the apps are.
* Handling of multi-app workspaces in Visual Studio Code.
* Management of environment references.
* Batch setup for *launch.json*.
* Batch creation of runtime packages.
* Batch deployment to environments both local and remote.
* Batch deployment of dependency apps into containers.

Also in the pipeline:

* Batch downloading of symbols.
* Stay tuned for more.

## Introduction

The purpose of this toolset is the management of local Windows or Widows Server development environments for Business Central projects. The goal is to make quick work of preparation of local Docker repositories, as well as other routinely executed management procedures, such as editing of *launch.json*. It's a simple, no brainer approach that might get more sophisticated in the future, but will always focus on simplicity.

It relies on information about your project/app that is already available from *app.json* or *repo.code-workspace*. Only the information that is not already there needs to be added to toolset's own settings. Part of the toolset's setting are developer's own preferences, while other, such as the locations of test environments, can be made available from within the repository, so that developers don't have to manage those manually.

It doesn't have an output or an artifact. The solution is the repository itself, with its ability to be integrated into projects. You can sever its tie to the origin by deleting the .git folder - that will prevent it from keeping itself up to date if that is what you want.

This toolset is a work in continuous progress. Any usage is subject to a MIT license as specified in the repository.

If you want to reach out to the developer, please open an issue at *[BC-Dev-Toolset](https://github.com/dam-pav/BC-Dev-Toolset/issues)*.

You are also welcome to apply as contributor. As a contributor you will implicitly agree to a [Contributor License Agreement](documentation/CLA.md). By accepting the agreement you will declare that you have the right to grant this project the rights to use your contribution and that you in fact do grant this right of use.

## Prerequisites

1. A **Windows Pro** or **Windows Enterprise** edition.
   Docker requires requires Hyper-V and a feature named Containers to work on Windows. Windows Home does not provide these features.
2. If you don't have access to any of the above, you won't be able to develop for BC using Docker. You might still find scripts that are not related to Docker useful for instance, if you only use actual environments.
   Make sure your BIOS has virtualization enabled. Hyper-V feature might appear to be enabled, but won't work without proper HW support.
3. Try the option that works for you

   1. **Docker Desktop**.

      ```
      winget install -e --id Docker.DockerDesktop
      ```

      You will need to switch to Windows containers. In order to do that, running this in a PowerShell prompt might help:

      ```
      & $Env:ProgramFiles\Docker\Docker\DockerCli.exe -SwitchDaemon
      ```
   2. **Docker Engine** (no Docker Desktop license required)
      Select and download the appropriate binary package, probably the latest, from
      [Index of win/static/stable/x86_64/](https://download.docker.com/win/static/stable/x86_64/)

      Unpack the content. A good location might be c:\docker.

      Now, to set up permissions. Check user groups under "Edit local users and group". The usual group name would be  docker-users and if it was created by some installation such as Docker Desktop it will contain the admin user.  Add anyone who needs to run docker to this group.

      The alternative is to use a group that already contains your user account, such as Users. Update the Json file below accordingly.

      Create a new config file daemon.json, containing this:

      ```
      {
                      "group": "docker-users"
      }
      ```

      You need to set up the docker-users user group yourself of course.

      Or, if you don't want or have no right to manage local groups, this should work just as fine:

      ```
      {
                      "group": "Users"
      }
      ```

      Open Powershell as administrator. Run:

      ```
        Enable-WindowsOptionalFeature -Online -FeatureName Containers -All
        Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All

        [System.Environment]::SetEnvironmentVariable('path',"$($env:path);c:\docker",'Machine')

        New-Service -Name Docker -BinaryPathName "C:\docker\dockerd.exe  --run-service --config-file C:\docker\daemon.json" -DisplayName "Docker Engine" -StartupType "Automatic"
      ```

      Make sure your installation folder was added to the PATH environment variable successfully. If the variable is longer then than 1024 characters it might misbehave despite the official limit of 32,767 characters, depending how it is used. SET and SETX truncate the var to 1024 characters, I do not recommend this method. Other methods might allow up to 2048 characters. If you can open your terminal and run 'docker' from any path other that from where you installed it, the you are good to go. Restart your PC.
4. **GIT**.
   You will need CLI for git. A good way to install it on a Windows PC is using WinGet. If you don't have WinGet yet, check [these GitHub repository releases](https://github.com/microsoft/winget-cli/releases/). Install using msixbundle.

   ```
   winget install -e --id Git.Git
   ```

   After the installation is done, close your PS terminal sessions and start a new to get access to git.
5. **Visual Studio Code**.

   ```
   winget install -e --id Microsoft.VisualStudioCode
   ```

   If you are not running Docker Desktop (or even if you are) I advise using the VS Code plugin named 'Container Tools', released by Microsoft.
6. **BcContainerHelper**.

   None of this would be possible without the BcContainerHelper. Hats off to Freddy.

   Run Powershell as admin, then:

   ```
   Install-Module BcContainerHelper -force
   ```

   This might not always work, reporting that module 'BcContainerHelper' cannot be found. Could be because powershellgallery.com is down, apparently this happens. In this case there is alternative: FreddyDK provided this script: [Install-BcContainerHelper.ps1]([https://github.com/BusinessCentralApps/HelloWorld/blob/master/scripts/Install-BcContainerHelper.ps1]()). Download and run.

   You can learn more at the [GitHub BcContainerHelper repository](https://github.com/microsoft/navcontainerhelper).

   *Note: the module is being updated from time to time. For your convenience, and update option is available in the list of Operations.*

## **Starting a new workspace**

There are two scenarios for workspaces, in relation to repositories they handle.

---

1. A workspace can contain one or more separate repositories, some of them containing an app of its own. The workspace definition in not included in any of them. It can include other otherwise independent folders, not necessarily containing apps. This is perfect for the developer that wants to use the toolset casually without involving it in any workflows.
2. The workspace can be part of a main repository. The main repository contains an arbitrary number of folders, some of them might contain apps. This is great for the developer that wants to predefine resources and setup for all team members.

---

Either way there is one requirement you must follow. Each separate app needs to have a separate base folder and this folder needs to be specified in the *folders* array in the workspace file. Like this:

```
{
  "folders": [
    {
      "path": "App 1"
    },
    {
      "name": "A more descriptive name for the app",
      "path": "App 2"
    }
  ]
}
```

It is best that the paths are relative to the workspace root, the location of the *.code-workspace* file, but full paths should work as well.

> There is a difference on how you write paths values and you can use this to your advantage. If a path is using  backslashes, such as:
>
> c:\\\projects\\\project\\\app
>
> then the toolkit will understand this is a full path and not treat it as relative to the workspace location. If you want to write a relative path, use slashes. For instance:
>
> project/app
>
> or
>
> ../../otherproject/app
>
> Don't mix the two kinds of slashes.

Starting a new workspace and including the toolset should be easy.

1. Define a *project.code-workspace* file (replace *project* with a proper name). The name of the project will become the default name for your Docker container. Your repository might already include such a file.
   You can create the workspace from VS Code, but creating it manually works just as well. You can also skip this step in which case the file will be create automatically by the toolset initialization.
2. Acquire a clone of the BC-Dev-Toolset repository.

   1. The easiest way is to get ***[initBCDevToolset.ps1](https://github.com/dam-pav/BC-Dev-Toolset/blob/main/common/initBCDevToolset.ps1)***, save it to the root of your repository (beside the *code-workspace* file) and run it with Powershell. This script executes substeps *ii* through *iv* for you. You might run into some trouble with the execution policy, since the script is not digitally signed (might happen in near future). In such event please bypass the policy by running:

      ```
      Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
      ```

      After this the script will run. Once you close the PS session (process is the scope), the bypass is gone.
      The script will:

      1. Create the subfolder named *BC-Dev-Toolset* and copy the  repository.
      2. Update the *.code-workspace* found, add the new subfolder to the *folders* array and add a placeholder setup to the settings structure.
      3. If a main repository is detected, create/update the *.gitignore* in order to exclude the toolset folder and *launch.json* files from git.
   2. If for some reason you want to prepare the toolset manually, take the following steps.

      The slightly longer approach would be to select the root folder for your repository, then execute this command line:

      ```
      git clone https://github.com/dam-pav/BC-Dev-Toolset.git
      ```

      If you accidentally cloned the toolset into somewhere else, there is nothing to worry about. Just move the folder where you need it. ***You can copy an existing folder from existing workspaces from your other projects.*** Technically, cloning is nothing more than making a copy, so any source will do, as long it includes the *.git* folder. The name of the toolset folder is not important, but *BC-Dev-Toolset* is a good name. Add this folder to the workspace (see Setup).
   3. If your workspace is going to be part of a repository, make sure this folder is ignored by git by specifying it in *.gitignore* at the root of your workspace. If the name of the toolset folder is *BC-Dev-Toolset*, add a line to *.gitignore*:
      **`BC-Dev-Toolset/`**
      Failing to exclude the toolset folder from main repository git will cause changes to your main repository with every update to the toolset. I do not recommend this.
      You can prevent updates from the toolset's origin by removing the *BC-Dev-Toolset\\.git* folder. I also do not recommend this.
   4. I do recommend to add **`launch.json`** to *.gitignore*. of the main repository in case of  These files are personalized per developer and managed by the toolset.
3. If you copied the toolset folder from another project, be sure to review and adjust the preexisting *settings.json*. If you delete it, it will be recreated with default values when you run any script.
4. Same goes for the preexisting *visualization\data.json*. Until run *visualization\\DataUpdate.ps1* and recreate the data, it might show wrong information.
5. You can create your first Docker container.

## Running the Toolset operations

For your convenience, all available functionality can be started using the ***RunOperation.ps1*** script found in the root of the BC-Dev-Toolset repository. Select the required operation from the menu and confirm by pressing *Enter*. You can select the operation by typing in the option number as well.

## Setup

### *.gitignore*

Add these two lines to the .gitignore file in the root of your repository:

```
BC-Dev-Toolset/
launch.json
```

Ignoring a BC-Dev-Toolset folder is only necessary if you are placing the folder within the project repository. You can avoid this by using relative paths.

You might have already initialized git with these folders and files. In that case mere modification of *.gitignore* will not suffice. You will need to run

```
git rm BC-Dev-Toolset -r -f --cached
```

in order to remove the folder and the containing files from git. Also, you might also need to run

```
git rm */launch.json --cached
```

to remove the files from git. You will need to commit these changes. Beware, this actually deletes the files from the current branch, not just the tracking.

### *project.code-workspace*

*.code-workspace is a configuration file for VSCode. For instance:

```
{
  "folders": [
    {
      "path": "Project/App"
    },
	{
      "path": "BC-Dev-Toolset"
    }
  ],
  "settings": {
    "liveServer.settings.multiRootWorkspaceName": "BC-Dev-Toolset",
    "powershell.cwd": "BC-Dev-Toolset",
    "dam-pav.bcdevtoolset": {
      "country": "w1",
      "selectArtifact": "Closest",
      "configurations":  [
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

#### Folders

The most obvious role of a workspace is to define the folders included. The path element can specify both absolute and relative paths. It makes sense to use relative paths, of course. A relative path is relative to the location of the .code-workspace file. You can set a structure of folders underneath so that paths such as "Project/App" is perfectly valid. This way you can exclude the BC-Dev-Toolset folder and the workspace definition itself from the file structure of the project without changes in gitignore.

#### Settings

In addition to folders containing separate apps we need to make sure one additional folder, containing the toolset, is also included.

We also use it as a vessel to carry configuration relevant to the workspace. The root attribute ***dam-pav.bcdevtoolset*** can specify:

* ***country***: optional, sets the platform country version. The default is "w1".
* ***selectArtifact***: "Closest" (default), "Latest"
* ***configurations***: Specify a list of remote deployments. Valid attributes (an approximate match of attributes for ***configurations*** in *launch.json*):

  * ***name***: a distinctive name for the configuration. This value is mandatory; the list entry will be ignored if ***name*** has an empty value or if the value is "sample".
  * ***serverType***: Accepted values are *Container*, *Cloud* or *OnPrem*. Mandatory.
  * ***targetType***: Accepted values are *Dev*, *Test*, *Production*.
  * ***server***: Valid for server type *OnPrem*.
  * ***serverInstance***: Valid for server type *OnPrem*.
  * ***container***: The name for the Docker container. The default value is the name of the workspace. Valid for server type *Container*.
  * ***port***: Valid for *OnPrem*.
  * ***environmentType***: Type of BC instance to create. Valid values are *Sandbox* or *OnPrem*. Default value is *Sandbox*. Valid for server type *Container* and *Cloud*.
  * ***environmentName***: Valid for Cloud.
  * ***includeTestToolkit***: Valid for server type Container.
  * ***tenant***: Valid for Cloud or OnPrem.
  * ***authentication***: Valid for Container or OnPrem. Default value is *UserPassword*.
  * ***admin*** and ***password***: The default user for the Docker BC instance.

### *settings.json*

VS Code usually provides three levels of scope:

- User: any settings are stored in the PC user profile. This is broader than any single project the user is working on.
- Workspace: the settings are stored in the .code-workspace json file. This is closer to the project scope, but migth not be local if the workpace is made part of the project repository. In a different sense, but this is still broader than a single project.
- Folder: a single folder specified in the workspace. So, much narrower than a single project, by definition.

The idea behind BC-Dev-Tools is that a developer needs to manage app development within a workspace, but the resources required are mostly local to the PC. Some of the setting must be customizable per both Project and the User. VS Code does not provide such a scope. That is why we keep a separate BC-Dev-Tools per each project and ose *settings.json* to customize your scripts behaviour.

If not found, a *settings.json* file will be created for you when any of the scripts is first run, with default values.

* ***licenseFile***: Specify if you have one. Mandatory for Runtime packages.
* ***certificateFile***: Specify if you have one. Mandatory for Runtime packages.
* ***packageOutputPath***: Specify a specific folder path to group the Runtime packages. If empty, a runtime subfolder will automatically be created and used in the project. Remember to use double backslashes for full paths. For instance, for an actual path of "c:\\project\\packages" you will need to use "c:\\\\project\\\packages\".
* ***dependenciesPath***: Specify a specific folder path to where the required app packages are stored. Again, remember to use double backslashes for full paths.
* ***shortcuts***: Decide where you want Docker to place shortcuts for the new containers it creates. Can be *None*, *Desktop* or *StartMenu*. While the Docker's default is Desktop, the toolsets's default is *None*.
* ***loadOnPremMgtModule***: Handling OnPrem deployments might require loading of the management module. This is where you specify its location in your specific context. Essentially, the path to NavAdminTool.ps1. This only works if you are running the scripts at the server host.
* ***configurations***: Locally personalized additional list of remote deployments. Valid attributes (a subset of attributes for ***configurations*** in *launch.json*). Same structure as defined for *.code-workspace*. Both lists are used.
