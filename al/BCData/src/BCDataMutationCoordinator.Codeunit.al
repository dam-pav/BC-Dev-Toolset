codeunit 50106 "BCD Mutation Coordinator"
{
    Access = Internal;
    // No Permissions elevation. Public permission/exposure integration is pending.
    // Each explicit operation prepares one server-issued, five-minute scope.
    procedure Prepare(RequestId: Guid): Text
    var
        Receipt: Record "BCD Mutation Receipt";
        Response: JsonObject;
        Output: Text;
    begin
        CheckRequestId(RequestId);
        Receipt.Principal := UserSecurityId();
        Receipt."Request ID" := RequestId;
        Receipt.Epoch := CreateGuid();
        Receipt."Retry Until" := CurrentDateTime() + 300000;
        // Boolean Insert resolves duplicate preparation through native uniqueness.
        if not Receipt.Insert() then begin
            Receipt.ReadIsolation := IsolationLevel::ReadCommitted;
            Receipt.Get(UserSecurityId(), RequestId);
            CheckScope(Receipt, Receipt.Epoch);
        end;
        // SQL DateTime storage may round the input millisecond. Advertise exactly
        // the persisted deadline, including on the first preparation response.
        Clear(Receipt);
        Receipt.ReadIsolation := IsolationLevel::ReadCommitted;
        Receipt.Get(UserSecurityId(), RequestId);
        Response.Add('requestId', LowerCase(Format(RequestId, 0, 4)));
        Response.Add('epoch', LowerCase(Format(Receipt.Epoch, 0, 4)));
        Response.Add('retryUntil', Format(Receipt."Retry Until", 0, 9));
        Response.WriteTo(Output);
        exit(Output);
    end;

    [CommitBehavior(CommitBehavior::Error)]
    procedure Execute(RequestId: Guid; Epoch: Guid; Input: Text): Text
    var
        Receipt: Record "BCD Mutation Receipt";
        Core: Codeunit "BCD Record Mutation";
        Request: JsonObject;
        Response: JsonObject;
        Token: JsonToken;
        Canonical: Text;
        ResultText: Text;
        StreamIn: InStream;
        StreamOut: OutStream;
    begin
        CheckRequestId(RequestId);
        Canonical := CanonicalPayload(Input);
        Request.ReadFrom(Canonical);
        // Scoped competitors, close and purge all take this lock before target locks.
        LoadLocked(Receipt, RequestId, Epoch);
        if Receipt.Completed then begin
            Receipt.CalcFields(Payload, Result);
            Receipt.Payload.CreateInStream(StreamIn, TextEncoding::UTF8);
            StreamIn.ReadText(ResultText);
            if ResultText <> Canonical then
                Error('BCD_REQUEST_ID_REUSED: completed request has a different payload.');
            RequireReplayRead(Receipt);
            Receipt.Result.CreateInStream(StreamIn, TextEncoding::UTF8);
            StreamIn.ReadText(ResultText);
            if ResultText = '' then
                Error('BCD_RECEIPT_UNAVAILABLE: completed history is unavailable; prior outcome is uncertain.');
            exit(ResultText);
        end;

        // Start an actual write transaction BEFORE any user validation/trigger code.
        // This anchor + CommitBehavior Error rejects explicit/implicit commit paths.
        Receipt."Owner Session ID" := SessionId();
        Receipt.Modify();
        ResultText := Core.Execute(Canonical);
        // A long-running mutation may cross its server-owned deadline.
        Receipt.Get(UserSecurityId(), RequestId);
        CheckScope(Receipt, Epoch);
        Response.ReadFrom(ResultText);
        Response.Add('requestId', LowerCase(Format(RequestId, 0, 4)));
        Response.WriteTo(ResultText);
        Response.Get('systemId', Token);
        Evaluate(Receipt."Target ID", Token.AsValue().AsText());
        Response.Get('tableId', Token);
        Receipt."Table ID" := Token.AsValue().AsInteger();
        Response.Get('operation', Token);
        Receipt.Operation := CopyStr(Token.AsValue().AsText(), 1, MaxStrLen(Receipt.Operation));
        Receipt.Payload.CreateOutStream(StreamOut, TextEncoding::UTF8);
        StreamOut.WriteText(Canonical);
        Receipt.Result.CreateOutStream(StreamOut, TextEncoding::UTF8);
        StreamOut.WriteText(ResultText);
        Receipt.Completed := true;
        Receipt.Modify();
        exit(ResultText);
    end;

    procedure Close(RequestId: Guid; Epoch: Guid)
    var
        Receipt: Record "BCD Mutation Receipt";
    begin
        CheckRequestId(RequestId);
        Receipt.LockTable();
        if not Receipt.Get(UserSecurityId(), RequestId) then
            Error('BCD_SCOPE_UNAVAILABLE: scope history is unavailable; do not recreate an uncertain command.');
        if IsNullGuid(Epoch) or (Receipt.Epoch <> Epoch) then
            Error('BCD_SCOPE_RETIRED: request scope does not match.');
        Receipt.Closed := true;
        Receipt.Modify();
    end;

    procedure PurgeExpired(RequestId: Guid; Epoch: Guid)
    var
        Receipt: Record "BCD Mutation Receipt";
    begin
        CheckRequestId(RequestId);
        Receipt.LockTable();
        if not Receipt.Get(UserSecurityId(), RequestId) then
            Error('BCD_SCOPE_UNAVAILABLE: scope history is unavailable.');
        if IsNullGuid(Epoch) or (Receipt.Epoch <> Epoch) then
            Error('BCD_SCOPE_RETIRED: request scope does not match.');
        if (Receipt."Retry Until" = 0DT) or (CurrentDateTime() < Receipt."Retry Until") then
            Error('BCD_SCOPE_ACTIVE: usable receipt history must not be purged.');
        // Execute never prepares missing state. Old epochs cannot execute after purge.
        Receipt.Delete();
    end;

    local procedure LoadLocked(var Receipt: Record "BCD Mutation Receipt"; RequestId: Guid; Epoch: Guid)
    begin
        Receipt.LockTable();
        if not Receipt.Get(UserSecurityId(), RequestId) then
            Error('BCD_SCOPE_UNAVAILABLE: scope history is unavailable; prior outcome is uncertain.');
        CheckScope(Receipt, Epoch);
    end;

    local procedure CheckScope(Receipt: Record "BCD Mutation Receipt"; Epoch: Guid)
    begin
        if IsNullGuid(Epoch) or (Receipt.Epoch <> Epoch) then
            Error('BCD_SCOPE_RETIRED: request scope does not match.');
        if Receipt.Closed then
            Error('BCD_SCOPE_CLOSED: requests are not carried into another operation.');
        if (Receipt."Retry Until" = 0DT) or (CurrentDateTime() >= Receipt."Retry Until") then
            Error('BCD_SCOPE_EXPIRED: retry window expired; prior outcome is uncertain.');
    end;

    local procedure CheckRequestId(RequestId: Guid)
    begin
        if IsNullGuid(RequestId) then
            Error('BCD_INVALID_INPUT: nonzero request ID required.');
        if CompanyName() = '' then
            Error('BCD_INVALID_INPUT: explicit company context required.');
    end;

    local procedure RequireReplayRead(Receipt: Record "BCD Mutation Receipt")
    var
        Target: RecordRef;
    begin
        // Delete history contains only acknowledgement metadata, never a row image.
        if Receipt.Operation = 'delete' then
            exit;
        Target.Open(Receipt."Table ID", false, CompanyName());
        Target.SecurityFiltering(SecurityFilter::Filtered);
        Target.ReadIsolation := IsolationLevel::ReadCommitted;
        if not Target.GetBySystemId(Receipt."Target ID") then
            Error('BCD_REPLAY_TARGET_UNAVAILABLE: original target is absent or not visible; prior application is unchanged.');
        Target.Close();
    end;

    local procedure CanonicalPayload(Input: Text): Text
    var
        Request: JsonObject;
        Canonical: JsonObject;
        Assignment: JsonObject;
        CanonicalAssignment: JsonObject;
        NormalizedValue: JsonObject;
        Assignments: JsonArray;
        CanonicalAssignments: JsonArray;
        Item: JsonToken;
        Token: JsonToken;
        PropertyNames: Text;
        Name: Text;
        KeyName: Text;
        Output: Text;
    begin
        if (StrLen(Input) > 32768) or not Request.ReadFrom(Input) then
            Error('BCD_INVALID_INPUT: mutation JSON exceeds its bound or is invalid.');
        PropertyNames := 'operation,tableId,systemId,expectedVersion,fields,primaryKey';
        foreach KeyName in Request.Keys() do
            if not PropertyNames.Split(',').Contains(KeyName) then
                Error('BCD_INVALID_INPUT: unknown mutation property.');
        foreach Name in PropertyNames.Split(',') do
            if Request.Get(Name, Token) then
                if Name in ['fields', 'primaryKey'] then begin
                    Assignments := Token.AsArray();
                    Clear(CanonicalAssignments);
                    foreach Item in Assignments do begin
                        Assignment := Item.AsObject();
                        if (Assignment.Keys().Count() <> 2) or not Assignment.Contains('fieldId') or not Assignment.Contains('value') then
                            Error('BCD_INVALID_INPUT: assignments require fieldId/value only.');
                        Clear(CanonicalAssignment);
                        Assignment.Get('fieldId', Token);
                        CanonicalAssignment.Add('fieldId', Token);
                        Assignment.Get('value', Token);
                        if Token.IsObject() then begin
                            NormalizedValue := Token.AsObject();
                            if (NormalizedValue.Keys().Count() <> 2) or not NormalizedValue.Contains('date') or not NormalizedValue.Contains('closing') then
                                Error('BCD_INVALID_INPUT: unsupported structured field value.');
                            Clear(Assignment);
                            NormalizedValue.Get('date', Item);
                            Assignment.Add('date', Item);
                            NormalizedValue.Get('closing', Item);
                            Assignment.Add('closing', Item);
                            CanonicalAssignment.Add('value', Assignment);
                        end else
                            CanonicalAssignment.Add('value', Token);
                        CanonicalAssignments.Add(CanonicalAssignment);
                    end;
                    Canonical.Add(Name, CanonicalAssignments);
                end else
                    Canonical.Add(Name, Token);
        Canonical.WriteTo(Output);
        exit(Output);
    end;
}
