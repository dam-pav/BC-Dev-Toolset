codeunit 50219 "BCD Replay Identity Probe"
{
    // Test administration only. Restricted roles cannot execute this object.
    // No Permissions property: native User/Tenant Permission rights are required.
    procedure PrepareRoles(inputJson: Text): Text
    var
        Role: Record "Tenant Permission Set";
        Receipt: Record "BCD Receipt Fixture";
        Target: Record "BCD Conflict Fixture";
        Objects: Record AllObjWithCaption;
        NamespaceId: Guid;
        Principal: Guid;
        Profile: Text;
        Profiles: List of [Text];
        NullGuid: Guid;
        Request: JsonObject;
        Token: JsonToken;
        RenamePolicy: Boolean;
        DeletePolicy: Boolean;
    begin
        Request.ReadFrom(inputJson);
        if Request.Get('renamePolicy', Token) then
            RenamePolicy := Token.AsValue().AsBoolean();
        if Request.Get('deletePolicy', Token) then
            DeletePolicy := Token.AsValue().AsBoolean();
        NamespaceId := GetGuid(inputJson, 'namespaceId');
        Profiles := ProfileList();
        foreach Profile in Profiles do
            if Role.Get(NullGuid, RoleId(NamespaceId, Profile)) then
                Error('BCD_EVP_ROLE_COLLISION');
        foreach Profile in Profiles do begin
            Principal := ProfilePrincipal(NamespaceId, Profile, true);
            Role.Init();
            Role."App ID" := NullGuid;
            Role."Role ID" := RoleId(NamespaceId, Profile);
            Role.Name := 'BCD EVP ' + Tag(NamespaceId);
            Role.Assignable := true;
            Role.Insert();
            AddPermission(Role."Role ID", 0, Database::Company, 'R', '');
            AddPermission(Role."Role ID", 5, Codeunit::"BCD Receipt Probe", '', '');
            AddPermission(Role."Role ID", 5, Codeunit::"BCD Versioned Receipt Probe", '', '');
            AddPermission(Role."Role ID", 5, Codeunit::"BCD Conflict Probe", '', '');
            // BC23's insert path invokes this Base Application subscriber even for
            // these unmapped fixture tables. Execution only; no extra table-data rights.
            AddPermission(Role."Role ID", 5, 7233, '', '');
            // Newer Base Application initialization also requires execution. Keep
            // this version-specific prerequisite conditional on the installed object.
            Objects.SetRange("Object Type", Objects."Object Type"::Codeunit);
            Objects.SetRange("Object ID", 36951);
            Objects.SetRange("Object Name", 'Initialization');
            if not Objects.IsEmpty() then
                AddPermission(Role."Role ID", 5, 36951, '', '');
            AddPermission(Role."Role ID", 1, Database::"BCD Receipt Run", '', '');
            AddPermission(Role."Role ID", 1, Database::"BCD Receipt Fixture", '', '');
            AddPermission(Role."Role ID", 1, Database::"BCD Conflict Fixture", '', '');
            AddPermission(Role."Role ID", 1, Database::"BCD Conflict Barrier", '', '');
            AddPermission(Role."Role ID", 0, Database::"BCD Conflict Barrier", 'RIMD', '');
            AddPermission(Role."Role ID", 0, Database::"BCD Receipt Run", 'RIMD', '');
            if DeletePolicy and (Profile = 'v') then
                AddPermission(Role."Role ID", 0, Database::"BCD Receipt Fixture", 'IMD',
                    Receipt.TableName() + ': Principal=' + Format(Principal, 0, 4))
            else
                AddPermission(Role."Role ID", 0, Database::"BCD Receipt Fixture", 'RIMD',
                    Receipt.TableName() + ': Principal=' + Format(Principal, 0, 4));
            case Profile of
                'r': AddPermission(Role."Role ID", 0, Database::"BCD Conflict Fixture", 'R',
                    Target.TableName() + ': Principal=' + Format(Principal, 0, 4));
                'n': AddPermission(Role."Role ID", 0, Database::"BCD Conflict Fixture", 'IMD',
                    Target.TableName() + ': Principal=' + Format(Principal, 0, 4));
                'v':
                    if RenamePolicy then
                        AddPermission(Role."Role ID", 0, Database::"BCD Conflict Fixture", 'R', Target.TableName() + ': Name=RENAMED')
                    else
                        AddPermission(Role."Role ID", 0, Database::"BCD Conflict Fixture", 'R', Target.TableName() + ': Amount=4');
                else AddPermission(Role."Role ID", 0, Database::"BCD Conflict Fixture", 'RIMD',
                    Target.TableName() + ': Principal=' + Format(Principal, 0, 4));
            end;
        end;
        exit('{"created":true}');
    end;

    procedure CleanupRoles(inputJson: Text): Text
    var
        Role: Record "Tenant Permission Set";
        Permission: Record "Tenant Permission";
        AccessControl: Record "Access Control";
        NamespaceId: Guid;
        Profile: Text;
        Profiles: List of [Text];
        NullGuid: Guid;
    begin
        NamespaceId := GetGuid(inputJson, 'namespaceId');
        Profiles := ProfileList();
        foreach Profile in Profiles do
            if Role.Get(NullGuid, RoleId(NamespaceId, Profile)) then begin
                Role.TestField(Name, 'BCD EVP ' + Tag(NamespaceId));
                AccessControl.SetRange("App ID", NullGuid);
                AccessControl.SetRange(Scope, AccessControl.Scope::Tenant);
                AccessControl.SetRange("Role ID", Role."Role ID");
                if not AccessControl.IsEmpty() then
                    Error('BCD_EVP_REMOVE_USERS_FIRST');
                Permission.SetRange("App ID", NullGuid);
                Permission.SetRange("Role ID", Role."Role ID");
                Permission.DeleteAll();
                Role.Delete();
            end;
        exit('{"cleaned":true}');
    end;

    procedure DataState(inputJson: Text): Text
    begin
        exit(DataStateOrCleanup(inputJson, false));
    end;

    procedure CleanupData(inputJson: Text): Text
    begin
        exit(DataStateOrCleanup(inputJson, true));
    end;

    local procedure DataStateOrCleanup(Input: Text; DeleteData: Boolean): Text
    var
        Run: Record "BCD Receipt Run";
        Receipt: Record "BCD Receipt Fixture";
        Target: Record "BCD Conflict Fixture";
        Barrier: Record "BCD Conflict Barrier";
        Ref: RecordRef;
        VersionField: FieldRef;
        Version: BigInteger;
        Request: JsonObject;
        Item: JsonObject;
        Row: JsonObject;
        Response: JsonObject;
        Items: JsonArray;
        Rows: JsonArray;
        Token: JsonToken;
        NamespaceId: Guid;
        RunId: Guid;
        Principal: Guid;
        Kind: Text;
        Exists: Boolean;
        Output: Text;
    begin
        NamespaceId := GetGuid(Input, 'namespaceId');
        Request.ReadFrom(Input);
        Request.Get('runs', Token);
        Items := Token.AsArray();
        if Items.Count() <> 2 then
            Error('BCD_EVP_INVALID_RUNS');
        foreach Token in Items do begin
            Item := Token.AsObject();
            Item.Get('kind', Token);
            Kind := Token.AsValue().AsText();
            if not (Kind in ['f', 'x']) then
                Error('BCD_EVP_INVALID_KIND');
            Item.WriteTo(Output);
            RunId := GetGuid(Output, 'runId');
            Principal := ProfilePrincipal(NamespaceId, Kind, false);
            Clear(Run);
            Exists := Run.Get(RunId);
            Receipt.Reset();
            Receipt.SetRange("Run ID", RunId);
            Target.Reset();
            Target.SetRange("Run ID", RunId);
            Barrier.Reset();
            Barrier.SetRange("Run ID", RunId);
            if Exists then begin
                if IsNullGuid(Principal) or (Run.Principal <> Principal) then
                    Error('BCD_EVP_DATA_OWNER_CHANGED');
                if Receipt.FindSet() then
                    repeat
                        if Receipt.Principal <> Principal then
                            Error('BCD_EVP_RECEIPT_OWNER_CHANGED');
                    until Receipt.Next() = 0;
                if Target.FindSet() then
                    repeat
                        if Target.Principal <> Principal then
                            Error('BCD_EVP_TARGET_OWNER_CHANGED');
                    until Target.Next() = 0;
            end else
                if not Receipt.IsEmpty() or not Target.IsEmpty() or not Barrier.IsEmpty() then
                    Error('BCD_EVP_ORPHAN_RECEIPT');
            if DeleteData and Exists then begin
                Receipt.DeleteAll();
                Target.DeleteAll();
                Barrier.DeleteAll();
                Run.Delete();
                Exists := false;
            end;
            Clear(Row);
            Row.Add('kind', Kind);
            Row.Add('runExists', Exists);
            Row.Add('receiptCount', Receipt.Count());
            Receipt.SetRange(Completed, false);
            Row.Add('pendingCount', Receipt.Count());
            Row.Add('total', Run.Total);
            Row.Add('applyCount', Run."Apply Count");
            Row.Add('targetCount', Target.Count());
            Row.Add('barrierCount', Barrier.Count());
            if Target.FindFirst() then begin
                Ref.GetTable(Target);
                VersionField := Ref.Field(0);
                Version := VersionField.Value;
                Row.Add('version', Format(Version, 0, 9));
                Row.Add('systemId', Format(Target.SystemId, 0, 4));
                Row.Add('amount', Target.Amount);
                Row.Add('name', Target.Name);
            end;
            Rows.Add(Row);
        end;
        Response.Add('rows', Rows);
        Response.WriteTo(Output);
        exit(Output);
    end;

    procedure RemoveCompanyExecution(inputJson: Text): Text
    var
        AccessControl: Record "Access Control";
        Company: Record Company;
        NamespaceId: Guid;
        CompanionAppId: Guid;
        Principal: Guid;
    begin
        // Test-only exact-key removal: the measured native cmdlet cannot select
        // System scope together with this nonzero application ID on BC23.
        NamespaceId := GetGuid(inputJson, 'namespaceId');
        Principal := ProfilePrincipal(NamespaceId, 'f', true);
        Company.SetRange(Id, GetGuid(inputJson, 'companyId'));
        Company.FindFirst();
        if (Company.Name <> 'CRONUS International Ltd.') and (Company.Name <> 'BCD_CT_' + Tag(NamespaceId)) then
            Error('BCD_EVP_COMPANY_OUTSIDE_SCOPE');
        Evaluate(CompanionAppId, '0f92aea5-4cc0-459b-ae98-ca9e5c2b0304');
        AccessControl.SetRange("User Security ID", Principal);
        AccessControl.SetRange("Role ID", 'BCD DATA EXECUTE');
        AccessControl.SetRange("Company Name", Company.Name);
        AccessControl.SetRange(Scope, AccessControl.Scope::System);
        AccessControl.SetRange("App ID", CompanionAppId);
        if AccessControl.Count() <> 1 then
            Error('BCD_EVP_EXECUTION_ASSIGNMENT_CHANGED');
        AccessControl.FindFirst();
        AccessControl.Delete(true);
        if not AccessControl.IsEmpty() then
            Error('BCD_EVP_EXECUTION_ASSIGNMENT_REMAINS');
        exit('{"removed":true}');
    end;

    procedure SetTargetAmount(inputJson: Text): Text
    var
        Run: Record "BCD Receipt Run";
        Target: Record "BCD Conflict Fixture";
        Request: JsonObject;
        Token: JsonToken;
        NamespaceId: Guid;
        RunId: Guid;
        Principal: Guid;
        Amount: Integer;
    begin
        NamespaceId := GetGuid(inputJson, 'namespaceId');
        RunId := GetGuid(inputJson, 'runId');
        Principal := ProfilePrincipal(NamespaceId, 'f', true);
        Run.Get(RunId);
        if Run.Principal <> Principal then
            Error('BCD_EVP_DATA_OWNER_CHANGED');
        Request.ReadFrom(inputJson);
        Request.Get('amount', Token);
        Amount := Token.AsValue().AsInteger();
        if not (Amount in [4, 9]) then
            Error('BCD_EVP_INVALID_AMOUNT');
        Target.LockTable();
        Target.SetRange("Run ID", RunId);
        Target.SetRange(Principal, Principal);
        Target.FindFirst();
        Target.Amount := Amount;
        Target.Modify();
        exit('{"changed":true}');
    end;

    procedure SetTargetName(inputJson: Text): Text
    var
        Run: Record "BCD Receipt Run";
        Target: Record "BCD Conflict Fixture";
        Request: JsonObject;
        Token: JsonToken;
        NamespaceId: Guid;
        RunId: Guid;
        Principal: Guid;
        Name: Text;
    begin
        // Fixed-key test administration only; never changes a receipt.
        NamespaceId := GetGuid(inputJson, 'namespaceId');
        RunId := GetGuid(inputJson, 'runId');
        Principal := ProfilePrincipal(NamespaceId, 'f', true);
        Run.Get(RunId);
        if Run.Principal <> Principal then
            Error('BCD_EVP_DATA_OWNER_CHANGED');
        Request.ReadFrom(inputJson);
        Request.Get('name', Token);
        Name := Token.AsValue().AsText();
        if not (Name in ['ORIGINAL', 'RENAMED']) then
            Error('BCD_EVP_INVALID_NAME');
        Target.LockTable();
        Target.SetRange("Run ID", RunId);
        Target.SetRange(Principal, Principal);
        Target.FindFirst();
        Target.Rename(RunId, Name);
        exit('{"changed":true}');
    end;

    procedure RestoreDeletedTarget(inputJson: Text): Text
    var
        Run: Record "BCD Receipt Run";
        Receipt: Record "BCD Receipt Fixture";
        Target: Record "BCD Conflict Fixture";
        RunId: Guid;
        Principal: Guid;
    begin
        // Test administration only: restore a different identity after one delete.
        RunId := GetGuid(inputJson, 'runId');
        Principal := ProfilePrincipal(GetGuid(inputJson, 'namespaceId'), 'f', true);
        Run.Get(RunId);
        if (Run.Principal <> Principal) or (Run."Apply Count" <> 1) then
            Error('BCD_EVP_DATA_OWNER_CHANGED');
        Receipt.SetRange("Run ID", RunId);
        Receipt.SetRange(Principal, Principal);
        if Receipt.Count() <> 1 then
            Error('BCD_EVP_DELETE_RECEIPT_REQUIRED');
        Receipt.FindFirst();
        if not Receipt.Completed or (CopyStr(Receipt.Payload, 1, 7) <> 'delete|') then
            Error('BCD_EVP_DELETE_RECEIPT_REQUIRED');
        Target.SetRange("Run ID", RunId);
        if not Target.IsEmpty() then
            Error('BCD_EVP_TARGET_STILL_EXISTS');
        Target.Init();
        Target."Run ID" := RunId;
        Target.Name := 'ORIGINAL';
        Target.Principal := Principal;
        Target.Amount := 4;
        Target.Insert();
        exit('{"restored":true}');
    end;

    local procedure AddPermission(RoleId: Code[20]; ObjectType: Integer; ObjectId: Integer; Rights: Text; Filter: Text)
    var
        Permission: Record "Tenant Permission";
    begin
        Permission.Init();
        Permission."Role ID" := RoleId;
        Permission."Object Type" := ObjectType;
        Permission."Object ID" := ObjectId;
        Permission."Read Permission" := Permission."Read Permission"::" ";
        Permission."Insert Permission" := Permission."Insert Permission"::" ";
        Permission."Modify Permission" := Permission."Modify Permission"::" ";
        Permission."Delete Permission" := Permission."Delete Permission"::" ";
        Permission."Execute Permission" := Permission."Execute Permission"::" ";
        if StrPos(Rights, 'R') > 0 then Permission."Read Permission" := Permission."Read Permission"::Yes;
        if StrPos(Rights, 'I') > 0 then Permission."Insert Permission" := Permission."Insert Permission"::Yes;
        if StrPos(Rights, 'M') > 0 then Permission."Modify Permission" := Permission."Modify Permission"::Yes;
        if StrPos(Rights, 'D') > 0 then Permission."Delete Permission" := Permission."Delete Permission"::Yes;
        if ObjectType <> 0 then Permission."Execute Permission" := Permission."Execute Permission"::Yes;
        if Filter <> '' then Evaluate(Permission."Security Filter", Filter);
        Permission.Insert();
    end;

    local procedure ProfileList(): List of [Text]
    var
        TextValue: Text;
    begin
        TextValue := 'f,x,r,n,v';
        exit(TextValue.Split(','));
    end;

    local procedure ProfilePrincipal(NamespaceId: Guid; Profile: Text; Required: Boolean): Guid
    var
        User: Record User;
        Kind: Text;
        NullGuid: Guid;
    begin
        Kind := Profile;
        if Profile in ['r', 'n', 'v'] then Kind := 'f';
        User.SetRange("User Name", 'bcd_evp_' + Tag(NamespaceId) + '_' + Kind);
        if not User.FindFirst() then begin
            if Required then Error('BCD_EVP_USER_MISSING');
            exit(NullGuid);
        end;
        if LowerCase(User."Full Name") <> LowerCase('BCD EVP ' + Format(NamespaceId, 0, 4)) then
            Error('BCD_EVP_USER_OWNER_CHANGED');
        exit(User."User Security ID");
    end;

    local procedure RoleId(NamespaceId: Guid; Profile: Text): Code[20]
    begin
        exit('BEVP' + Tag(NamespaceId) + Profile);
    end;

    local procedure Tag(Id: Guid): Text[12]
    begin
        exit(CopyStr(DelChr(LowerCase(Format(Id, 0, 4)), '=', '{}-'), 1, 12));
    end;

    local procedure GetGuid(Input: Text; Name: Text): Guid
    var
        Request: JsonObject;
        Token: JsonToken;
        Id: Guid;
    begin
        Request.ReadFrom(Input);
        Request.Get(Name, Token);
        if not Evaluate(Id, Token.AsValue().AsText()) then Error('BCD_EVP_INVALID_ID');
        if IsNullGuid(Id) then Error('BCD_EVP_INVALID_ID');
        exit(Id);
    end;
}
