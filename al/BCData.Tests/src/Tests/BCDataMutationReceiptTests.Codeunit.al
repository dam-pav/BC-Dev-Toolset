codeunit 50223 "BCD Mutation Receipt Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure InsertReplayCanonicalizesPropertyOrder()
    var
        Row: Record "BCD Mutation Fixture";
        Receipt: Record "BCD Mutation Receipt";
        Request: JsonObject;
        Reordered: JsonObject;
        Response: JsonObject;
        Token: JsonToken;
        RequestId: Guid;
        Epoch: Guid;
        RunId: Guid;
        ResultText: Text;
        Prepared: Text;
    begin
        RequestId := CreateGuid();
        RunId := CreateGuid();
        Prepared := Coordinator.Prepare(RequestId);
        Assert.AreEqual(Prepared, Coordinator.Prepare(RequestId), 'Duplicate preparation must not renew its epoch/deadline.');
        Epoch := EpochFrom(Prepared);
        Request := InsertRequest(RunId, 'A');
        ResultText := Coordinator.Execute(RequestId, Epoch, ToText(Request));
        Request.Get('fields', Token);
        Reordered.Add('fields', Token);
        Reordered.Add('tableId', Database::"BCD Mutation Fixture");
        Reordered.Add('operation', 'insert');
        Assert.AreEqual(ResultText, Coordinator.Execute(RequestId, Epoch, ToText(Reordered)), 'Same command replays the exact stored result.');
        Row.Get(RunId, 'A', 1);
        Row.TestField("Insert Count", 1);
        CheckLogCount(RunId, 1);
        Receipt.Get(UserSecurityId(), RequestId);
        Receipt.TestField(Completed, true);
        Assert.IsTrue(Receipt."Owner Session ID" > 0, 'A successful reservation identifies its owning session.');
        Response.ReadFrom(ResultText);
        Response.Get('requestId', Token);
        Assert.AreEqual(LowerCase(Format(RequestId, 0, 4)), Token.AsValue().AsText(), 'Result identifies its request.');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure ModifyReplaysHistoryBeforeStaleCheck()
    var
        Row: Record "BCD Mutation Fixture";
        Request: JsonObject;
        RequestId: Guid;
        Epoch: Guid;
        RunId: Guid;
        ResultText: Text;
    begin
        RunId := CreateGuid();
        Core.Execute(ToText(InsertRequest(RunId, 'A')));
        Row.Get(RunId, 'A', 1);
        RequestId := CreateGuid();
        Epoch := EpochFrom(Coordinator.Prepare(RequestId));
        Request := ExistingRequest('modify', Row);
        AddFields(Request, 4, '"4"');
        ResultText := Coordinator.Execute(RequestId, Epoch, ToText(Request));
        Commit();
        Row.Get(RunId, 'A', 1);
        Row.Description := 'later change';
        Row.Modify(true);
        Commit();
        Assert.AreEqual(ResultText, Coordinator.Execute(RequestId, Epoch, ToText(Request)), 'Historical result precedes now-stale expected version.');
        Row.Get(RunId, 'A', 1);
        Row.TestField("Modify Count", 2);
        AddFields(Request, 4, '"5"');
        asserterror Coordinator.Execute(RequestId, Epoch, ToText(Request));
        Assert.ExpectedError('BCD_REQUEST_ID_REUSED');
        Row.Get(RunId, 'A', 1);
        Row.TestField(Quantity, 4);
        Clean(RunId, RequestId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure RenameAndDeleteReplayDoNotTouchReplacement()
    var
        Row: Record "BCD Mutation Fixture";
        Receipt: Record "BCD Mutation Receipt";
        Request: JsonObject;
        Assignments: JsonArray;
        RenameRequestId: Guid;
        DeleteRequestId: Guid;
        RenameEpoch: Guid;
        DeleteEpoch: Guid;
        RunId: Guid;
        OriginalId: Guid;
        ReplacementId: Guid;
        RenameResult: Text;
        DeleteResult: Text;
    begin
        RunId := CreateGuid();
        Core.Execute(ToText(InsertRequest(RunId, 'A')));
        Row.Get(RunId, 'A', 1);
        OriginalId := Row.SystemId;
        RenameRequestId := CreateGuid();
        RenameEpoch := EpochFrom(Coordinator.Prepare(RenameRequestId));
        Request := ExistingRequest('rename', Row);
        Assignments.ReadFrom('[{"fieldId":1,"value":"' + Format(RunId, 0, 4) + '"},{"fieldId":2,"value":"B"},{"fieldId":3,"value":1}]');
        Request.Add('primaryKey', Assignments);
        RenameResult := Coordinator.Execute(RenameRequestId, RenameEpoch, ToText(Request));
        Commit();
        Assert.AreEqual(RenameResult, Coordinator.Execute(RenameRequestId, RenameEpoch, ToText(Request)), 'Rename replays without a second trigger.');
        Row.Get(RunId, 'B', 1);
        Assert.AreEqual(OriginalId, Row.SystemId, 'Rename preserves original identity.');
        DeleteRequestId := CreateGuid();
        DeleteEpoch := EpochFrom(Coordinator.Prepare(DeleteRequestId));
        Request := ExistingRequest('delete', Row);
        DeleteResult := Coordinator.Execute(DeleteRequestId, DeleteEpoch, ToText(Request));
        Commit();
        Core.Execute(ToText(InsertRequest(RunId, 'B')));
        Row.Get(RunId, 'B', 1);
        ReplacementId := Row.SystemId;
        Commit();
        Assert.AreNotEqual(OriginalId, ReplacementId, 'Same-key replacement has a new identity.');
        Assert.AreEqual(DeleteResult, Coordinator.Execute(DeleteRequestId, DeleteEpoch, ToText(Request)), 'Delete replays acknowledgement only.');
        Row.Get(RunId, 'B', 1);
        Assert.AreEqual(ReplacementId, Row.SystemId, 'Historical delete cannot delete the replacement.');
        Receipt.Get(UserSecurityId(), RenameRequestId);
        Receipt.Delete();
        Clean(RunId, DeleteRequestId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure FailedValidationDoesNotConsumeRequest()
    var
        Request: JsonObject;
        RequestId: Guid;
        Epoch: Guid;
        RunId: Guid;
    begin
        RequestId := CreateGuid();
        RunId := CreateGuid();
        Epoch := EpochFrom(Coordinator.Prepare(RequestId));
        Commit();
        Request := InsertRequest(RunId, 'A');
        AppendField(Request, 4, '"-1"');
        asserterror Coordinator.Execute(RequestId, Epoch, ToText(Request));
        Assert.ExpectedError('BCD_GENERIC_QUANTITY_NEGATIVE');
        CheckFailedReservation(RunId, RequestId);
        Request := InsertRequest(RunId, 'A');
        Coordinator.Execute(RequestId, Epoch, ToText(Request));
        CheckLogCount(RunId, 1);
        Clean(RunId, RequestId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure ClosedExpiredAndPurgedScopesCannotExecute()
    var
        Receipt: Record "BCD Mutation Receipt";
        Request: JsonObject;
        RequestId: Guid;
        Epoch: Guid;
        NewEpoch: Guid;
        RunId: Guid;
    begin
        RequestId := CreateGuid();
        RunId := CreateGuid();
        Epoch := EpochFrom(Coordinator.Prepare(RequestId));
        Request := InsertRequest(RunId, 'A');
        Coordinator.Execute(RequestId, Epoch, ToText(Request));
        Commit();
        asserterror Coordinator.PurgeExpired(RequestId, Epoch);
        Assert.ExpectedError('BCD_SCOPE_ACTIVE');
        Coordinator.Close(RequestId, Epoch);
        Commit();
        asserterror Coordinator.Execute(RequestId, Epoch, ToText(Request));
        Assert.ExpectedError('BCD_SCOPE_CLOSED');
        asserterror Coordinator.Prepare(RequestId);
        Assert.ExpectedError('BCD_SCOPE_CLOSED');
        Receipt.Get(UserSecurityId(), RequestId);
        Receipt.Closed := false;
        Receipt."Retry Until" := CurrentDateTime() - 1000;
        Receipt.Modify();
        Commit();
        asserterror Coordinator.Execute(RequestId, Epoch, ToText(Request));
        Assert.ExpectedError('BCD_SCOPE_EXPIRED');
        Coordinator.PurgeExpired(RequestId, Epoch);
        Commit();
        asserterror Coordinator.Execute(RequestId, Epoch, ToText(Request));
        Assert.ExpectedError('BCD_SCOPE_UNAVAILABLE');
        NewEpoch := EpochFrom(Coordinator.Prepare(RequestId));
        Assert.AreNotEqual(Epoch, NewEpoch, 'Explicit re-preparation after purge has a new epoch.');
        Commit();
        asserterror Coordinator.Execute(RequestId, Epoch, ToText(Request));
        Assert.ExpectedError('BCD_SCOPE_RETIRED');
        CheckLogCount(RunId, 1);
        Clean(RunId, RequestId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure ReceiptAnchorBlocksCommitUsingValidation()
    var
        Request: JsonObject;
        RequestId: Guid;
        Epoch: Guid;
        RunId: Guid;
        Mode: Text;
        Modes: Text;
    begin
        Modes := 'BCD_COMMIT,BCD_IMPLICIT';
        foreach Mode in Modes.Split(',') do begin
            RequestId := CreateGuid();
            RunId := CreateGuid();
            Epoch := EpochFrom(Coordinator.Prepare(RequestId));
            Commit();
            Request := InsertRequest(RunId, 'A');
            AppendField(Request, 12, '"' + Mode + '"');
            asserterror Coordinator.Execute(RequestId, Epoch, ToText(Request));
            CheckFailedReservation(RunId, RequestId);
            Clean(RunId, RequestId);
        end;
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure DeadlineCrossingRollsBackMutationAndReceipt()
    var
        Receipt: Record "BCD Mutation Receipt";
        Request: JsonObject;
        RequestId: Guid;
        Epoch: Guid;
        RunId: Guid;
    begin
        RequestId := CreateGuid();
        RunId := CreateGuid();
        Epoch := EpochFrom(Coordinator.Prepare(RequestId));
        Commit();
        Request := InsertRequest(RunId, 'A');
        AppendField(Request, 22, '"' + Format(RequestId, 0, 4) + '"');
        AppendField(Request, 12, '"BCD_EXPIRE_RECEIPT"');
        asserterror Coordinator.Execute(RequestId, Epoch, ToText(Request));
        Assert.ExpectedError('BCD_SCOPE_EXPIRED');
        CheckFailedReservation(RunId, RequestId);
        Receipt.Get(UserSecurityId(), RequestId);
        Assert.IsTrue(Receipt."Retry Until" > CurrentDateTime(), 'Injected deadline change rolls back too.');
        Clean(RunId, RequestId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure ReceiptStateCannotBeGenericMutationTarget()
    var
        Request: JsonObject;
    begin
        Request.ReadFrom('{"operation":"insert","tableId":50100,"fields":[{"fieldId":1,"value":"00000000-0000-0000-0000-000000000000"}]}');
        asserterror Core.Execute(ToText(Request));
        Assert.ExpectedError('companion request state cannot be a mutation target');
    end;

    local procedure EpochFrom(Prepared: Text): Guid
    var
        Response: JsonObject;
        Token: JsonToken;
        Epoch: Guid;
    begin
        Response.ReadFrom(Prepared);
        Response.Get('epoch', Token);
        Evaluate(Epoch, Token.AsValue().AsText());
        exit(Epoch);
    end;

    local procedure CheckFailedReservation(RunId: Guid; RequestId: Guid)
    var
        Row: Record "BCD Mutation Fixture";
        Receipt: Record "BCD Mutation Receipt";
    begin
        Row.SetRange("Run ID", RunId);
        Assert.IsTrue(Row.IsEmpty(), 'Failed command leaves no target.');
        CheckLogCount(RunId, 0);
        Receipt.Get(UserSecurityId(), RequestId);
        Receipt.TestField(Completed, false);
        Receipt.TestField("Owner Session ID", 0);
        Receipt.CalcFields(Payload, Result);
        Assert.IsFalse(Receipt.Payload.HasValue() or Receipt.Result.HasValue(), 'Failed command leaves no payload/result reservation.');
    end;

    local procedure CheckLogCount(RunId: Guid; Expected: Integer)
    var
        Entry: Record "BCD Mutation Trigger Log";
    begin
        Entry.SetRange("Run ID", RunId);
        Assert.AreEqual(Expected, Entry.Count(), 'Native trigger effects occur only for applied commands.');
    end;

    local procedure Clean(RunId: Guid; RequestId: Guid)
    var
        Row: Record "BCD Mutation Fixture";
        Entry: Record "BCD Mutation Trigger Log";
        Receipt: Record "BCD Mutation Receipt";
    begin
        Row.SetRange("Run ID", RunId);
        Row.DeleteAll();
        Entry.SetRange("Run ID", RunId);
        Entry.DeleteAll();
        Receipt.Get(UserSecurityId(), RequestId);
        Receipt.Delete();
    end;

    local procedure InsertRequest(RunId: Guid; Name: Text): JsonObject
    var
        Request: JsonObject;
    begin
        Request.ReadFrom('{"operation":"insert","tableId":50221,"fields":[{"fieldId":1,"value":"' + Format(RunId, 0, 4) +
            '"},{"fieldId":2,"value":"' + Name + '"},{"fieldId":3,"value":1}]}');
        exit(Request);
    end;

    local procedure ExistingRequest(Operation: Text; Row: Record "BCD Mutation Fixture"): JsonObject
    var
        Request: JsonObject;
    begin
        Request.Add('operation', Operation);
        Request.Add('tableId', Database::"BCD Mutation Fixture");
        Request.Add('systemId', Format(Row.SystemId, 0, 4));
        Request.Add('expectedVersion', Format(Row.SystemRowVersion, 0, 9));
        exit(Request);
    end;

    local procedure AddFields(var Request: JsonObject; FieldId: Integer; Input: Text)
    begin
        if Request.Contains('fields') then
            Request.Remove('fields');
        AppendField(Request, FieldId, Input);
    end;

    local procedure AppendField(var Request: JsonObject; FieldId: Integer; Input: Text)
    var
        Assignments: JsonArray;
        Assignment: JsonObject;
        Token: JsonToken;
    begin
        if Request.Get('fields', Token) then
            Assignments := Token.AsArray();
        Token.ReadFrom(Input);
        Assignment.Add('fieldId', FieldId);
        Assignment.Add('value', Token);
        Assignments.Add(Assignment);
        if Request.Contains('fields') then
            Request.Replace('fields', Assignments)
        else
            Request.Add('fields', Assignments);
    end;

    local procedure ToText(Request: JsonObject): Text
    var
        Output: Text;
    begin
        Request.WriteTo(Output);
        exit(Output);
    end;

    var
        Coordinator: Codeunit "BCD Mutation Coordinator";
        Core: Codeunit "BCD Record Mutation";
        Assert: Codeunit "Library Assert";
}
