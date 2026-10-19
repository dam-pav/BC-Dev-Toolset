codeunit 50217 "BCD Versioned Receipt Probe"
{
    // E04/E06 composition fixture: fixed insert/modify/rename, no elevated permissions.
    procedure Prepare(inputJson: Text): Text
    begin
        exit(Conflict.Prepare(inputJson));
    end;

    procedure PrepareEmpty(inputJson: Text): Text
    var
        Run: Record "BCD Receipt Run";
    begin
        Run."Run ID" := ReadGuid(inputJson, 'runId');
        Run.Principal := UserSecurityId();
        Run.Insert();
        exit(Conflict.Inspect(inputJson));
    end;

    [CommitBehavior(CommitBehavior::Error)]
    procedure Execute(inputJson: Text): Text
    var
        Receipt: Record "BCD Receipt Fixture";
        Run: Record "BCD Receipt Run";
        Request: JsonObject;
        Token: JsonToken;
        ResultObject: JsonObject;
        RowState: JsonObject;
        RunId: Guid;
        RequestId: Guid;
        TargetId: Guid;
        Version: BigInteger;
        VersionText: Text;
        Operation: Text;
        Payload: Text;
        ResultText: Text;
        Amount: Integer;
        FailAfterMutation: Boolean;
    begin
        RunId := ReadGuid(inputJson, 'runId');
        RequestId := ReadGuid(inputJson, 'requestId');
        TargetId := ReadGuid(inputJson, 'systemId');
        CheckOwner(Run, RunId);
        Request.ReadFrom(inputJson);
        Request.Get('operation', Token);
        Operation := Token.AsValue().AsText();
        if not (Operation in ['insert', 'modify', 'rename']) then
            Error('BCD_EV_INVALID_OPERATION');
        if Operation = 'insert' then begin
            if Request.Get('expectedVersion', Token) then
                Error('BCD_EV_INVALID_VERSION');
            // Fixed insertion key, not a version token for a nonexistent row.
            VersionText := 'ORIGINAL';
        end else begin
            Request.Get('expectedVersion', Token);
            VersionText := Token.AsValue().AsText();
            if not Evaluate(Version, VersionText, 9) then
                Error('BCD_EV_INVALID_VERSION');
            if (Version <= 0) or (Format(Version, 0, 9) <> VersionText) then
                Error('BCD_EV_INVALID_VERSION');
        end;
        if Operation in ['insert', 'modify'] then begin
            Request.Get('amount', Token);
            Amount := Token.AsValue().AsInteger();
            if (Amount < -1000000) or (Amount > 1000000) then
                Error('BCD_EV_AMOUNT_RANGE');
        end;
        if Request.Get('failAfterMutation', Token) then
            FailAfterMutation := Token.AsValue().AsBoolean();
        Payload := Operation + '|' + Format(TargetId, 0, 4) + '|' + VersionText + '|';
        if Operation in ['insert', 'modify'] then
            Payload += Format(Amount, 0, 9)
        else
            // The E04 fixture has exactly one rename destination; no generic key API.
            Payload += 'RENAMED';
        if StrLen(Payload) > MaxStrLen(Receipt.Payload) then
            Error('BCD_EV_PAYLOAD_TOO_LONG');
        Receipt."Run ID" := RunId;
        Receipt.Principal := UserSecurityId();
        Receipt."Request ID" := RequestId;
        Receipt.Payload := CopyStr(Payload, 1, MaxStrLen(Receipt.Payload));
        Receipt."Owner Session ID" := SessionId();
        // Reserve before target lookup/version checks or user mutation code.
        if not Receipt.Insert() then begin
            Receipt.ReadIsolation := IsolationLevel::ReadCommitted;
            Receipt.Get(RunId, UserSecurityId(), RequestId);
            if Receipt.Payload <> Payload then
                Error('BCD_EV_REQUEST_ID_REUSED');
            if not Receipt.Completed then
                Error('BCD_EV_INCOMPLETE_RECEIPT');
            RequireReplayTarget(RunId, TargetId);
            exit(Receipt.Result);
        end;
        // Existing E04 path locks, rereads and compares before mutation.
        if Operation = 'insert' then begin
            InsertTarget(inputJson, RunId, TargetId, Amount);
            RowState.ReadFrom(Conflict.Inspect(inputJson));
        end else
            RowState.ReadFrom(Conflict.Execute(inputJson));
        Run.LockTable();
        Run.Get(RunId);
        Run."Apply Count" += 1;
        Run.Modify();
        if FailAfterMutation then
            Error('BCD_EV_AFTER_MUTATION');
        ResultObject.Add('requestId', Format(RequestId, 0, 4));
        ResultObject.Add('resultId', Format(CreateGuid(), 0, 4));
        ResultObject.Add('row', RowState);
        ResultObject.Add('applyCount', Run."Apply Count");
        ResultObject.WriteTo(ResultText);
        if StrLen(ResultText) > MaxStrLen(Receipt.Result) then
            Error('BCD_EV_RESULT_TOO_LONG');
        Receipt.Result := CopyStr(ResultText, 1, MaxStrLen(Receipt.Result));
        Receipt.Completed := true;
        Receipt.Modify();
        exit(ResultText);
    end;

    local procedure InsertTarget(Input: Text; RunId: Guid; TargetId: Guid; Amount: Integer)
    var
        Target: Record "BCD Conflict Fixture";
        Request: JsonObject;
        Token: JsonToken;
        DelayMs: Integer;
    begin
        Request.ReadFrom(Input);
        if Request.Get('delayMs', Token) then
            DelayMs := Token.AsValue().AsInteger();
        if (DelayMs < 0) or (DelayMs > 5000) then
            Error('BCD_EV_INVALID_DELAY');
        if DelayMs > 0 then
            Sleep(DelayMs);
        if Target.GetBySystemId(TargetId) then
            Error('BCD_EV_INSERT_CONFLICT');
        Clear(Target);
        Target."Run ID" := RunId;
        Target.Name := 'ORIGINAL';
        Target.Principal := UserSecurityId();
        Target.Amount := Amount;
        Target.SystemId := TargetId;
        if not Target.Insert(true, true) then
            Error('BCD_EV_INSERT_CONFLICT');
    end;

    procedure PrepareReplacement(inputJson: Text): Text
    var
        Run: Record "BCD Receipt Run";
        Row: Record "BCD Conflict Fixture";
        RunId: Guid;
    begin
        // Test-only replacement of a previously deleted fixture row. Never edits receipts.
        RunId := ReadGuid(inputJson, 'runId');
        CheckOwner(Run, RunId);
        Row.SetRange("Run ID", RunId);
        if not Row.IsEmpty() then
            Error('BCD_EV_TARGET_STILL_EXISTS');
        Row.Init();
        Row."Run ID" := RunId;
        Row.Name := 'ORIGINAL';
        Row.Principal := UserSecurityId();
        Row.Insert();
        exit(Conflict.Inspect(inputJson));
    end;

    procedure Inspect(inputJson: Text): Text
    var
        Receipt: Record "BCD Receipt Fixture";
        Run: Record "BCD Receipt Run";
        Response: JsonObject;
        RowState: JsonObject;
        Output: Text;
    begin
        CheckOwner(Run, ReadGuid(inputJson, 'runId'));
        Run.ReadIsolation := IsolationLevel::ReadCommitted;
        Run.Get(Run."Run ID");
        RowState.ReadFrom(Conflict.Inspect(inputJson));
        Response.Add('row', RowState);
        Response.Add('applyCount', Run."Apply Count");
        Receipt.ReadIsolation := IsolationLevel::ReadCommitted;
        Receipt.SetRange("Run ID", Run."Run ID");
        Receipt.SetRange(Principal, UserSecurityId());
        Response.Add('receiptCount', Receipt.Count());
        Receipt.SetRange(Completed, false);
        Response.Add('pendingCount', Receipt.Count());
        Response.WriteTo(Output);
        exit(Output);
    end;

    procedure ObservePending(inputJson: Text): Text
    var
        Probe: Codeunit "BCD Receipt Probe";
    begin
        exit(Probe.ObservePending(inputJson));
    end;

    procedure Cleanup(inputJson: Text): Text
    var
        Receipt: Record "BCD Receipt Fixture";
        Run: Record "BCD Receipt Run";
        RunId: Guid;
    begin
        RunId := ReadGuid(inputJson, 'runId');
        Receipt.SetRange("Run ID", RunId);
        Receipt.SetRange(Principal, UserSecurityId());
        if Run.Get(RunId) then begin
            CheckOwner(Run, RunId);
            Receipt.DeleteAll();
            Conflict.Cleanup(inputJson);
        end else
            if not Receipt.IsEmpty() then
                Error('BCD_EV_MISSING_OWNER');
        exit(CleanState(inputJson));
    end;

    procedure CleanState(inputJson: Text): Text
    var
        Receipt: Record "BCD Receipt Fixture";
        Response: JsonObject;
        Output: Text;
    begin
        Response.ReadFrom(Conflict.CleanState(inputJson));
        Receipt.SetRange("Run ID", ReadGuid(inputJson, 'runId'));
        Receipt.SetRange(Principal, UserSecurityId());
        Response.Add('receiptCount', Receipt.Count());
        Response.WriteTo(Output);
        exit(Output);
    end;

    local procedure CheckOwner(var Run: Record "BCD Receipt Run"; RunId: Guid)
    begin
        Run.Get(RunId);
        if Run.Principal <> UserSecurityId() then
            Error('BCD_EV_OWNER_MISMATCH');
    end;

    local procedure RequireReplayTarget(RunId: Guid; TargetId: Guid)
    var
        Target: RecordRef;
        Field: FieldRef;
        Found: Boolean;
    begin
        // Insert/modify/rename receipt policy: current native table/row Read and visibility are
        // required for result disclosure. Do not compare the historical version.
        Target.Open(Database::"BCD Conflict Fixture");
        Target.SecurityFiltering(SecurityFilter::Filtered);
        Target.ReadIsolation := IsolationLevel::ReadCommitted;
        Field := Target.Field(Target.SystemIdNo());
        Field.SetRange(TargetId);
        Field := Target.Field(1);
        Field.SetRange(RunId);
        Field := Target.Field(3);
        Field.SetRange(UserSecurityId());
        Found := Target.FindFirst();
        Target.Close();
        if not Found then
            Error('BCD_EV_REPLAY_TARGET_UNAVAILABLE');
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
            Error('BCD_EV_INVALID_ID');
        if IsNullGuid(Value) then
            Error('BCD_EV_INVALID_ID');
        exit(Value);
    end;

    var
        Conflict: Codeunit "BCD Conflict Probe";
}
