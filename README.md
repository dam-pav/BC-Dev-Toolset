# Business Central Developer's Toolset

## Why?

If you are a BC developer, you might have to spend an inordinate amount of time manually executing operations such as preparing your development tools and setup, preparing and deploying packages and so on. I'm sure you'd rather spend that time doing something less dull and repetitive.

Also, many developers still find using local containers cumbersome and find all kinds of excuses to avoid this. However, using isolated development environments is essential. It almost feels redundant having to stress this fact but here I am, saying this.

The things that the toolset will enable you to do once it is set up:

* Creating exactly the containers your app needs based on what the apps are.
* Backup and restore of container-compatible SQL backup sets. If present, the backup set is automatically used when creating a new container.
* Managing the BC service parameters
* Executing tests, both "classic" and Page Scripting.
* Handling of multi-app workspaces in Visual Studio Code.
* Management of environment references.
* Batch setup for *launch.json*.
* Batch creation of runtime packages.
* Batch deployment to environments both local and remote.
* Batch deployment of dependency apps into containers.

## Introduction

The purpose of this toolset is the management of local Windows or Windows Server development environments for Business Central projects. The goal is to make quick work of preparation of local Docker environments, as well as other routinely executed management procedures, such as editing of *launch.json*. It's a simple, no-brainer approach that might get more sophisticated in the future, but will always focus on simplicity.

It relies on information about your project/app that is already available from *app.json* or *repo.code-workspace*. Only the information that is not already there needs to be added to the toolset's own settings. Part of the toolset's settings are developers' own preferences, while others, such as the locations of test environments, can be made available from within the repository, so that developers don't have to manage those manually.

> The information about the required container artifact version is retrieved from the first app and its app.json. The relevant element is "application". If you manage this value manually, make sure you don't fiddle with the "platform" element as well. The "platform" element informs your environment about which symbols to download and the app versions are not always aligned with the container (platform) version. In fact, more usually than not they contain older versions that had no reason to be updated. The chief example is the System app which is not released as often as other apps.

This toolset is a work in continuous progress. Any usage is subject to a MIT license as specified in the repository.

If you want to reach out to the developer, please open an issue at *[BC-Dev-Toolset](https://github.com/dam-pav/BC-Dev-Toolset/issues)*.

You are also welcome to apply as a contributor. As a contributor you will implicitly agree to a [Contributor License Agreement](documentation/CLA.md). By accepting the agreement you will declare that you have the right to grant this project the rights to use your contribution and that you in fact do grant this right of use.

## Quick Start

You already have your VS Code running? It's as simple as 1,2,3.

1. Open the Extension Marketplace, search for *BC Dev Toolset* and install.
2. Open Command Palette, select *BC Dev Toolset: Install Prerequisites* and run the operation.
3. Open Command Palette, select BC Dev Toolset: Configure workspace and run.

Your development environment for your current workspace is ready and you can start with creating your container, managing your workspace etc.

## Running the Toolset operations

### Command Palette

All the operations are available through the VS Code Command Palette. You can type them out directly or you can use the ***BC Dev Toolset: Show Operations List*** that will let you select any of the operations from a drop-down menu.

### Prerequisites

1. A **Windows Pro** or **Windows Enterprise** edition.
   Docker requires Hyper-V and a feature named Containers to work on Windows. Windows Home does not provide these features. Make sure your BIOS has virtualization enabled. The Hyper-V feature might appear to be enabled, but won't work without proper HW support.

   If you don't have access to any of the above, you won't be able to develop for BC using Docker. You might still find scripts that are not related to Docker useful, for instance, if you only use "regular" environments without containers.

   If your OS is suitable, you can proceed with the rest of the prerequisites.
2. **Visual Studio Code** (or any of the forks that support .vsix extensions).

   ```
   winget install -e --id Microsoft.VisualStudioCode
   ```

   > **At this point you install the BC-Dev-Toolset extension.**
   >
   > The extension includes an operation named Install Prerequisites that can take care of the steps below. Simply type into the Command Palette: ***BC Dev Toolset: Install prerequisites***.
   >
   > - installs the latest version of Docker Engine
   > - configures the required Windows features
   > - installs git
   > - installs BcContainerHelper
   >
   > The operation will not verify the presence of Docker Desktop.
   >
   > If this is a problem or if you simply prefer to do this manually, please continue following the steps.
   >
3. Try the container solution that works for you

   If you are not running Docker Desktop (or even if you are) I advise using the VS Code plugin named *Container Tools*, released by Microsoft.

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

      The alternative is to use a group that already contains your user account, such as Users. Update the JSON file below accordingly.

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

      Open PowerShell as administrator. Run:

      ```
        Enable-WindowsOptionalFeature -Online -FeatureName Containers -All
        Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All

        [System.Environment]::SetEnvironmentVariable('path',"$($env:path);c:\docker",'Machine')

        New-Service -Name Docker -BinaryPathName "C:\docker\dockerd.exe  --run-service --config-file C:\docker\daemon.json" -DisplayName "Docker Engine" -StartupType "Automatic"
      ```

      Make sure your installation folder was added to the PATH environment variable successfully. If the variable is longer than 1024 characters it might misbehave despite the official limit of 32,767 characters, depending how it is used. SET and SETX truncate the var to 1024 characters, I do not recommend this method. Other methods might allow up to 2048 characters. If you can open your terminal and run 'docker' from any path other than where you installed it, then you are good to go. Restart your PC.
4. **GIT**.
   You will need CLI for git. A good way to install it on a Windows PC is using WinGet. If you don't have WinGet yet, check [these GitHub repository releases](https://github.com/microsoft/winget-cli/releases/). Install using msixbundle.

   ```
   winget install -e --id Git.Git
   ```

   After the installation is done, close your PS terminal sessions and start a new one to get access to git.
5. **BcContainerHelper**.

   None of this would be possible without the BcContainerHelper. Hats off to Freddy.

   Run PowerShell as admin, then:

   ```
   Install-Module BcContainerHelper -force
   ```

   This might not always work, reporting that module 'BcContainerHelper' cannot be found. Could be because powershellgallery.com is down, apparently this happens. In this case there is an alternative: FreddyDK provided this script: [Install-BcContainerHelper.ps1]([https://github.com/BusinessCentralApps/HelloWorld/blob/master/scripts/Install-BcContainerHelper.ps1]()). Download and run.

   You can learn more at the [GitHub BcContainerHelper repository](https://github.com/microsoft/navcontainerhelper).

   *Note: the module is being updated from time to time. For your convenience, an update option is available in the list of Operations.*

### Workspaces

There are two scenarios for workspaces, in relation to repositories they handle.

---

1. A workspace can contain one or more separate repositories, some of them containing an app of its own. The workspace definition is not included in any of them. It can include other otherwise independent folders, not necessarily containing apps. This is perfect for the developer that wants to use the toolset casually without involving it in any workflows.
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

Starting a new workspace should be easy.

1. Define a *project.code-workspace* file and replace *project* with a proper name. **Choose the name carefully. If you work on multiple workspaces it can save you a lot of guesswork** The name of the project will become the default name for your Docker container. Your repository might already include such a file.
   You can create the workspace from VS Code, but creating it manually works just as well. You can also skip this step in which case the file will be created automatically by the toolset initialization.
2. I do recommend to add **`launch.json`** to *.gitignore*. These files are personalized per developer and managed by the toolset.
3. You can now create your first Docker container.

### Backup & Restore

Be aware that backup and restore work only within the context of the same BC release. The database defines the version which is limited to running on a specific platform (service). You cannot use this to "upgrade" your data in a meaningful way, say use a configuration from BC22 in BC27.

That said; you can maintain data persistence in a couple of ways. One is to use the backup and restore functionality of *BcContainerHelper*. You can backup the current state of your container and restore it later, or share it with other developers. You can retrieve the state of a central test database and use it with your development to find test scenarios more easily or skip tedious configuration.

SQL backup operations create and consume a compatible backup set in *sqlBackupPath*. Container backups and regular BC service SQL Server backups use the same file naming convention: *\<database\>.app.bak* for the application database, *\<database\>.tenant.bak* for multitenant tenant databases, or *\<database\>.database.bak* for a single-tenant database.

To retrieve bak files from a SQL Server host you will require credentials with the ability to create remote Powershell sessions to the SQL Server host.

You can follow the naming convention manually and prepare a bak file set manually, if you find yourself unable to use the toolset backup scripts. A regular MS artifact based container is multi-tenant and contains three databases. *CRONUS* is the app database while the other two, *default* and *tenant*, are tenant databases.

## Setup

### *.gitignore*

Add this line to the `.gitignore` file in the root of your repository:

```
launch.json
```

You might have already initialized git with these files. In that case mere modification of `.gitignore` will not suffice. You might also need to run

```
git rm */launch.json --cached
```

to remove the files from git. You will need to commit these changes. Beware, this might actually delete the files from the current folder, not just the tracking.

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
          "name": "Local",
          "serverType": "Container",
          "targetType": "Dev",
          "container": "TEST",
          "environmentType": "Sandbox",
          "includeTestToolkit": "true",
          "authentication": "UserPassword",
          "bcUser": "admin",
          "bcPassword": "P@ssw0rd",
          "network": "transparent",
          "macAddress": "02:42:ac:11:00:02",
          "IP": "",
          "dns": "HostDNS",
          "serverConfiguration": [
            {
              "KeyName": "NavHttpClientMaxTimeout",
              "KeyValue": "00:30:00"
            },
            {
              "KeyName": "EnableTaskScheduler",
              "KeyValue": true
            }
          ]
        },
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

The most obvious role of a workspace is to define the folders included. The path element can specify both absolute and relative paths. It makes sense to use relative paths, of course. A relative path is relative to the location of the .code-workspace file. You can set a structure of folders underneath so that paths such as "Project/App" is perfectly valid.

#### Settings

BC Dev Toolset uses three settings layers:

- Extension settings in VS Code under `bcDevToolset.*`
- Workspace settings in the `.code-workspace` file under `dam-pav.bcdevtoolset`
- Local settings in `.bcdevtoolset/settings.json`

### Extension settings

These are VS Code extension settings. They belong to the developer's VS Code setup rather than to the repository.

- `bcDevToolset.toolsetPath`: Overrides the central BC-Dev-Toolset runtime location.
- `bcDevToolset.powershellExecutable`: PowerShell executable used to run operations.
- `bcDevToolset.localSettingsPath`: Workspace-relative path to the local settings file.
- `bcDevToolset.shortcuts`: Decide where you want Docker to place shortcuts for the new containers it creates. Can be *None*, *Desktop* or *StartMenu*. While Docker's default is *Desktop*, the toolsets's default is *None*.
- `bcDevToolset.hostHelperFolder`: Overrides default BcContainerHelper host helper folder used by runtime operations.

### Workspace settings

These are stored in the `.code-workspace` file under the root attribute `dam-pav.bcdevtoolset`. Use them for shared project settings that should travel with the workspace.

- `country`: Optional platform country version. The default is `w1`.
- `selectArtifact`: Artifact selection strategy. Common values are `Closest` and `Latest`.
- `configurations`: Shared list of deployment targets for the workspace.

#### Configurations

> Note: The same configuration schema applies to both workspaces and local settings.

Each `configurations` entry can contain:

- `name`: Distinctive name of the configuration. Mandatory. Entries with an empty name or the name `sample` are ignored.
- `serverType`: Accepted values are `Container`, `Cloud`, or `OnPrem`. Mandatory.
- `targetType`: Accepted values are `Dev`, `Test`, `Production`.
- `server`: Valid for `OnPrem`.
- `serverInstance`: Valid for `OnPrem`.
- `container`: Docker container name. The default value is the name of the workspace. Valid for `Container`.
- `port`: Valid for `OnPrem`.
- `environmentType`: Type of BC instance to create. Valid values are `Sandbox` or `OnPrem`. The default is `Sandbox`. Valid for `Container` and `Cloud`.
- `environmentName`: Valid for `Cloud`.
- `includeTestToolkit`: Valid for `Container`.
- `tenant`: Valid for `Cloud` or `OnPrem`.
- `authentication`: Valid for `Container` or `OnPrem`. The default value is `UserPassword`.
- `bcUser`: Default user for the BC instance.
- `bcPassword`: Default password for the BC instance.
- `admin`: Obsolete fallback for `bcUser`. Use `bcUser` instead; this field will be removed in the next major release.
- `password`: Obsolete fallback for `bcPassword`. Use `bcPassword` instead; this field will be removed in the next major release.
- `network`: Optional Docker network passed to `New-BcContainer`. Valid for `Container`. Suggested Windows container network values include `NAT`, `transparent`, `l2bridge`, `l2tunnel`, `overlay`, and `none`; custom Docker network names are also allowed. For suggested network names, the toolset verifies that the Docker network exists with the expected driver and creates missing creatable networks, for example `docker network create -d transparent transparent`. Custom network setup is left to the user. Use a transparent network when the container should appear on the LAN with a real address.
- `hostIP`: Optional `host.containerhelper.internal` IP address passed to `New-BcContainer`. Valid for `Container`.
- `macAddress`: Optional container MAC address passed to `New-BcContainer`. Valid when `serverType` is `Container` and `network` is `transparent`. Use Docker's colon-delimited MAC address format, for example `02:42:ac:11:00:02`.
- `IP`: Optional static container IP address passed to `New-BcContainer`. Valid when `serverType` is `Container` and `network` is `transparent`. Leave empty to let the selected network assign the address, for example through DHCP.
- `dns`: Optional DNS value passed to `New-BcContainer`. Valid when `serverType` is `Container` and `network` is `transparent`. `HostDNS` adds the host DNS servers; explicit DNS server values are also allowed. Use a comma-delimited string for multiple DNS servers, for example `8.8.8.8,1.1.1.1`.
- `databaseUser`: Optional SQL authentication user for regular SQL Server backup operations. If empty, Windows authentication is used.
- `databasePassword`: Optional SQL authentication password for regular SQL Server backup operations.
- `remoteUser`: Optional PowerShell remoting user for remote SQL Server backup operations. If empty, the current Windows identity is used.
- `remotePassword`: Optional PowerShell remoting password for remote SQL Server backup operations.
- `serverConfiguration`: List of `KeyName` and `KeyValue` pairs.

### Local settings

VS Code settings have user, workspace, and folder scopes, but BC Dev Toolset operates at a project-local developer-specific scope. That is why the toolset keeps a separate `.bcdevtoolset/settings.json` file for values that should stay local to the workstation.

> **Note:** If you place more than one `.code-workspace` file in the same folder, these workspaces will all share the same `.bcdevtoolset/settings.json` setup.

If not found, a `settings.json` file will be created for you when any of the scripts is first run, with default values.

These settings are stored in `.bcdevtoolset/settings.json`:

- `licenseFile`: Specify if you have one. Mandatory for runtime packages.
- `certificateFile`: Specify if you have one. Mandatory for runtime packages.
- `packageOutputPath`: Folder path for runtime packages. If empty, a `runtime` subfolder is created and used in the project.
- `dependenciesPath`: Folder path containing the required app packages.
- `sqlBackupPath`: Local folder used by SQL backup operations. Container backup, BC service SQL Server backup, restore, and new-container initialization all use this folder as the common backup-set location.
- `loadOnPremMgtModule`: Path to `NavAdminTool.ps1` when OnPrem deployments need the management module on the server host.
- `configurations`: Developer-local additional list of deployment targets. It uses the same structure as workspace `configurations`, and both lists are used together.

> **Note:** BC 21.1 (BC 2022 release wave 2) introduced global and workspace launch configuration. This is interesting but not in the same scope and purpose as the ***configurations*** in BC Dev Tools which can also be set in the workspace. Launch setup is used directly by VS Code to deploy and start apps. Configurations is used by BC Dev Tools to initialize launch setup at app level, where a workspace can contain tens of apps. After that, you are free to use and modify the initialized setup. Sure, instead of using launch setup at app level you can use a single setup at the workspace level and if that fits your requirements, by all means do that. However, if you need any kind of granularity, for instance, having different pages loading when running different apps, you may want to stick with app level setup. BC Dev Tools doesn't initialize launch setup at workspace level at this time.
