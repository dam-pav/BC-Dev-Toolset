codeunit 50216 "BCD Conflict Probe"
{
    // Dedicated E04 fixture only. No receipt, elevated permissions or production API.
    procedure Prepare(inputJson: Text): Text
    var
        Row: Record "BCD Conflict Fixture";
        Run: Record "BCD Receipt Run";
    begin
        Run."Run ID" := ReadGuid(inputJson, 'runId');
        Run.Principal := UserSecurityId();
        Run.Insert();
        Row."Run ID" := Run."Run ID";
        Row.Name := 'ORIGINAL';
        Row.Principal := UserSecurityId();
        Row.Insert();
        exit(Inspect(inputJson));
    end;

    [CommitBehavior(CommitBehavior::Error)]
    procedure Execute(inputJson: Text): Text
    begin
        exit(Apply(inputJson, true));
    end;

    [CommitBehavior(CommitBehavior::Error)]
    procedure UncheckedControl(inputJson: Text): Text
    begin
        // Deliberately flawed initial-check-only control, confined to the test app.
        exit(Apply(inputJson, false));
    end;

    local procedure Apply(Input: Text; Recheck: Boolean): Text
    var
        Row: Record "BCD Conflict Fixture";
        Barrier: Record "BCD Conflict Barrier";
        Request: JsonObject;
        Token: JsonToken;
        RunId: Guid;
        SystemIdValue: Guid;
        Expected: BigInteger;
        Operation: Text;
        VersionText: Text;
        DelayMs: Integer;
    begin
        RunId := ReadGuid(Input, 'runId');
        CheckOwner(RunId);
        SystemIdValue := ReadGuid(Input, 'systemId');
        Request.ReadFrom(Input);
        Request.Get('expectedVersion', Token);
        VersionText := Token.AsValue().AsText();
        if not Evaluate(Expected, VersionText, 9) then
            Error('BCD_E04_INVALID_VERSION');
        if (Expected <= 0) or (Format(Expected, 0, 9) <> VersionText) then
            Error('BCD_E04_INVALID_VERSION');
        Request.Get('operation', Token);
        Operation := Token.AsValue().AsText();
        if not (Operation in ['modify', 'delete', 'rename']) then
            Error('BCD_E04_INVALID_OPERATION');
        if Request.Get('delayMs', Token) then
            DelayMs := Token.AsValue().AsInteger();
        if (DelayMs < 0) or (DelayMs > 5000) then
            Error('BCD_E04_INVALID_DELAY');

        // A preliminary check is insufficient: another session can write after it.
        LoadTarget(Row, RunId, SystemIdValue);
        CheckVersion(Row, Expected);
        if DelayMs > 0 then begin
            Barrier."Run ID" := RunId;
            Barrier."Owner Session ID" := SessionId();
            // Using the Boolean result disables AL bulk-insert buffering so the
            // independent dirty observer can see this transaction before Sleep.
            if not Barrier.Insert() then
                Error('BCD_E04_DUPLICATE_BARRIER');
            Sleep(DelayMs);
        end;

        // The protected reread and comparison must share the mutation transaction.
        Clear(Row);
        Row.LockTable();
        LoadTarget(Row, RunId, SystemIdValue);
        if Recheck then
            CheckVersion(Row, Expected);
        case Operation of
            'modify':
                begin
                    Request.Get('amount', Token);
                    Row.Amount := Token.AsValue().AsInteger();
                    Row.Modify(true);
                end;
            'delete': Row.Delete(true);
            'rename': Row.Rename(RunId, 'RENAMED');
        end;
        exit(Inspect(Input));
    end;

    procedure Inspect(inputJson: Text): Text
    var
        Row: Record "BCD Conflict Fixture";
        Response: JsonObject;
        Found: Boolean;
        Output: Text;
    begin
        CheckOwner(ReadGuid(inputJson, 'runId'));
        Row.ReadIsolation := IsolationLevel::ReadCommitted;
        Row.SetRange("Run ID", ReadGuid(inputJson, 'runId'));
        Found := Row.FindFirst();
        Response.Add('exists', Found);
        if Found then begin
            Response.Add('systemId', Format(Row.SystemId, 0, 4));
            Response.Add('version', Format(RowVersion(Row), 0, 9));
            Response.Add('name', Row.Name);
            Response.Add('amount', Row.Amount);
        end;
        Response.Add('sessionId', SessionId());
        Response.WriteTo(Output);
        exit(Output);
    end;

    procedure Observe(inputJson: Text): Text
    var
        Barrier: Record "BCD Conflict Barrier";
        Response: JsonObject;
        Output: Text;
    begin
        CheckOwner(ReadGuid(inputJson, 'runId'));
        SelectLatestVersion();
        Barrier.ReadIsolation := IsolationLevel::ReadUncommitted;
        Barrier.SetRange("Run ID", ReadGuid(inputJson, 'runId'));
        Response.Add('found', Barrier.FindFirst());
        Response.Add('ownerSessionId', Barrier."Owner Session ID");
        Response.Add('observerSessionId', SessionId());
        Response.WriteTo(Output);
        exit(Output);
    end;

    procedure Cleanup(inputJson: Text): Text
    var
        Row: Record "BCD Conflict Fixture";
        Barrier: Record "BCD Conflict Barrier";
        Run: Record "BCD Receipt Run";
        RunId: Guid;
    begin
        RunId := ReadGuid(inputJson, 'runId');
        if Run.Get(RunId) then begin
            CheckOwner(RunId);
            Row.SetRange("Run ID", RunId);
            Row.SetRange(Principal, UserSecurityId());
            Row.DeleteAll();
            Barrier.SetRange("Run ID", RunId);
            Barrier.DeleteAll();
            Run.Delete();
        end;
        exit(CleanState(inputJson));
    end;

    procedure CleanState(inputJson: Text): Text
    var
        Row: Record "BCD Conflict Fixture";
        Barrier: Record "BCD Conflict Barrier";
        Run: Record "BCD Receipt Run";
        Response: JsonObject;
        RunId: Guid;
        Output: Text;
    begin
        RunId := ReadGuid(inputJson, 'runId');
        if Run.Get(RunId) then
            CheckOwner(RunId);
        Row.SetRange("Run ID", RunId);
        Barrier.SetRange("Run ID", RunId);
        Response.Add('runExists', Run.Get(RunId));
        Response.Add('rows', Row.Count());
        Response.Add('barriers', Barrier.Count());
        Response.WriteTo(Output);
        exit(Output);
    end;

    local procedure LoadTarget(var Row: Record "BCD Conflict Fixture"; RunId: Guid; Id: Guid)
    begin
        if not Row.GetBySystemId(Id) then
            Error('BCD_E04_NOT_FOUND');
        if (Row."Run ID" <> RunId) or (Row.Principal <> UserSecurityId()) then
            Error('BCD_E04_TARGET_MISMATCH');
    end;

    local procedure CheckVersion(Row: Record "BCD Conflict Fixture"; Expected: BigInteger)
    begin
        if RowVersion(Row) <> Expected then
            Error('BCD_E04_CONFLICT');
    end;

    local procedure RowVersion(Row: Record "BCD Conflict Fixture"): BigInteger
    var
        Ref: RecordRef;
        Field: FieldRef;
        Value: BigInteger;
    begin
        Ref.GetTable(Row);
        Field := Ref.Field(0);
        Value := Field.Value;
        exit(Value);
    end;

    local procedure CheckOwner(RunId: Guid)
    var
        Run: Record "BCD Receipt Run";
    begin
        Run.Get(RunId);
        if Run.Principal <> UserSecurityId() then
            Error('BCD_E04_OWNER_MISMATCH');
    end;

    local procedure ReadGuid(Input: Text; Name: Text): Guid
    var
        Request: JsonObject;
        Token: JsonToken;
        Value: Guid;
    begin
        Request.ReadFrom(Input);
        Request.Get(Name, Token);
        if not Evaluate(Value, Token.AsValue().AsText()) then
            Error('BCD_E04_INVALID_ID');
        if IsNullGuid(Value) then
            Error('BCD_E04_INVALID_ID');
        exit(Value);
    end;
}
