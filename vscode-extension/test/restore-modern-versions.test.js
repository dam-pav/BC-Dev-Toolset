'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const source = path.resolve(__dirname, '../../common/BackupMgt.ps1').replace(/'/g, "''");

for (const mode of ['aligned', 'missing', 'duplicate', 'invalid', 'newer', 'older', 'cross-major', 'package-split', 'package-missing', 'query-error', 'legacy-empty', 'second-tenant']) {
  test('restored tenant application verification: ' + mode, () => {
    const script = `
      $ErrorActionPreference='Stop'; . '${source}'
      $script:sql=0; $script:repair=0; $script:queries=@(); $script:tenant=''
      function Get-BcContainerSqlBackupRestoreParameters { @{containerName='target';bakFolder='unused'} }
      function Restore-DatabasesInBcContainer { $script:sql++ }
      function Invoke-ScriptInBcContainer { param($ScriptBlock,[object[]]$ArgumentList) & $ScriptBlock @ArgumentList }
      function Get-NAVTenant { [pscustomobject]@{Id='default'}; if('${mode}' -eq 'second-tenant'){[pscustomobject]@{Id='north'}} }
      function Get-Item { [pscustomobject]@{FullName=[IO.Path]::GetTempPath();VersionInfo=@{FileVersion=$(if('${mode}' -eq 'legacy-empty'){'26.0.0.0'}else{'27.0.54968.57745'})}} }
      function Test-Path { -not ('${mode}' -eq 'package-missing') }
      function Get-NAVApplication { if('${mode}' -ne 'legacy-empty'){throw 'UNEXPECTED LEGACY QUERY'}; [pscustomobject]@{ApplicationVersion=''} }
      function Get-NAVAppInfo {
        [CmdletBinding()]param($ServerInstance,$Tenant,$Path)
        if ($Path) {
          $name=if($Path -match 'System Application'){'System Application'}elseif($Path -match 'BaseApp'){'Base Application'}else{'Application'}
          $version=if('${mode}' -eq 'package-split' -and $name -eq 'Application'){'27.4.0.0'}else{'27.5.46862.57838'}
          return [pscustomobject]@{Name=$name;Publisher='Microsoft';Version=$version}
        }
        $script:queries+= $Tenant
        if('${mode}' -eq 'query-error'){Write-Error 'private backend payload'}
        foreach($name in @('System Application','Base Application','Application')) {
          if(('${mode}' -eq 'missing' -or ('${mode}' -eq 'second-tenant' -and $Tenant -eq 'north')) -and $name -eq 'Base Application'){continue}
          $version=switch('${mode}') { invalid {'invalid'} newer {'27.6.0.0'} older {'27.4.0.0'} cross-major {'26.5.0.0'} default {'27.5.46862.57838'} }
          [pscustomobject]@{Name=$name;Publisher='Microsoft';Version=$version}
          if('${mode}' -eq 'duplicate' -and $name -eq 'Base Application'){[pscustomobject]@{Name=$name;Publisher='Microsoft';Version=$version}}
        }
      }
      function Set-NAVApplication { throw 'UNEXPECTED LEGACY WRITE' }
      function Publish-NAVApp { throw 'UNEXPECTED UPGRADE' }
      function Repair-BcContainerAdministratorAfterRestore { $script:repair++ }
      $entries=if('${mode}' -eq 'second-tenant'){@('default','north') | ForEach-Object {[pscustomobject]@{DatabaseRole='tenant';DatabaseName=$_}}}else{@()}
      $script:messages=@()
      try { Restore-BcContainerSqlBackupEntries -containerName target -bakFolder unused -backupEntries @($entries) -configuration ([pscustomobject]@{}) 6>&1 | ForEach-Object { $script:messages += [string]$_ } }
      catch { $failure=$_.Exception }
      @{sql=$script:sql;repair=$script:repair;queries=$script:queries;messages=$script:messages;message=$failure.Message;expected=$(if($failure){$failure.Data['BcDevToolsetExpectedFailure']}else{$false})}|ConvertTo-Json -Compress
      if($failure){exit 1}
    `;
    const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(result.status,mode==='aligned'?0:1,result.stderr+'\n'+result.stdout);
    const value=JSON.parse(result.stdout.trim());
    assert.equal(value.sql,1);
    assert.equal(value.repair,mode==='aligned'?1:0);
    if(mode==='aligned') {
      const messages=value.messages.join('\n');
      assert.match(messages,/Platform\/media: 27\.0\.54968\.57745/);
      for(const name of ['System Application','Base Application','Application']) {
        assert.ok(messages.includes(`${name}: installed '27.5.46862.57838', container package '27.5.46862.57838'`),messages);
      }
      assert.doesNotMatch(messages,/Database application version:/);
    }
    assert.doesNotMatch(result.stdout+result.stderr,/UNEXPECTED|private backend/);
    if(mode!=='aligned') {
      assert.equal(value.expected,true);
      assert.match(value.message,/SQL restore returned/);
      assert.match(value.message,/Inspect|Check/);
      assert.match(value.message,/No automatic retry or alternate restore/);
    }
    if(mode==='second-tenant') assert.deepEqual(value.queries,['default','north']);
  });
}
