codeunit 50209 "BCD Versioned Receipt Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure HistoricalReplayPrecedesStaleVersionCheck()
    var
        RunId: Guid;
        Original: JsonObject;
        Current: JsonObject;
        Request: Text;
        FirstResult: Text;
    begin
        Prepare(RunId, Original);
        Request := Mutation(RunId, CreateGuid(), Original, 4, false);
        FirstResult := Probe.Execute(Request);
        Commit();
        Current := State(RunId);
        Probe.Execute(Mutation(RunId, CreateGuid(), Row(Current), 9, false));
        Commit();
        Assert.AreEqual(FirstResult, Probe.Execute(Request), 'Replay returns the original result despite stale token and later mutation.');
        CheckState(RunId, 9, 2, 2);
        Probe.Cleanup(RunRequest(RunId));
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure ChangedVersionForCompletedIdIsPayloadMismatch()
    var
        RunId: Guid;
        RequestId: Guid;
        Original: JsonObject;
        Current: JsonObject;
    begin
        Prepare(RunId, Original);
        RequestId := CreateGuid();
        Probe.Execute(Mutation(RunId, RequestId, Original, 4, false));
        Commit();
        Current := State(RunId);
        asserterror Probe.Execute(Mutation(RunId, RequestId, Row(Current), 4, false));
        Assert.ExpectedError('BCD_EV_REQUEST_ID_REUSED');
        CheckState(RunId, 4, 1, 1);
        Probe.Cleanup(RunRequest(RunId));
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure StaleNewRequestRollsBackReservationThenFreshRetrySucceeds()
    var
        RunId: Guid;
        RequestId: Guid;
        Original: JsonObject;
        Current: JsonObject;
    begin
        Prepare(RunId, Original);
        Probe.Execute(Mutation(RunId, CreateGuid(), Original, 4, false));
        Commit();
        RequestId := CreateGuid();
        asserterror Probe.Execute(Mutation(RunId, RequestId, Original, 9, false));
        Assert.ExpectedError('BCD_E04_CONFLICT');
        CheckState(RunId, 4, 1, 1);
        Current := State(RunId);
        Probe.Execute(Mutation(RunId, RequestId, Row(Current), 9, false));
        Commit();
        CheckState(RunId, 9, 2, 2);
        Probe.Cleanup(RunRequest(RunId));
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure PostMutationFailureRollsBackVersionCounterAndReceipt()
    var
        RunId: Guid;
        RequestId: Guid;
        Original: JsonObject;
        Current: JsonObject;
    begin
        Prepare(RunId, Original);
        RequestId := CreateGuid();
        asserterror Probe.Execute(Mutation(RunId, RequestId, Original, 4, true));
        Assert.ExpectedError('BCD_EV_AFTER_MUTATION');
        Current := State(RunId);
        Assert.AreEqual(Value(Original, 'version'), Value(Row(Current), 'version'), 'Rolled back row has its original version.');
        CheckState(RunId, 0, 0, 0);
        Probe.Execute(Mutation(RunId, RequestId, Original, 4, false));
        Commit();
        CheckState(RunId, 4, 1, 1);
        Probe.Cleanup(RunRequest(RunId));
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure RenameReceiptPreservesIdentityAndHistoricalResult()
    var
        RunId: Guid;
        Original: JsonObject;
        Current: JsonObject;
        Request: Text;
        FirstResult: Text;
    begin
        Prepare(RunId, Original);
        Request := RenameRequest(RunId, CreateGuid(), Original, false);
        FirstResult := Probe.Execute(Request);
        Commit();
        Current := State(RunId);
        Assert.AreEqual('RENAMED', Value(Row(Current), 'name'), 'Renamed key persisted.');
        Assert.AreEqual(Value(Original, 'systemId'), Value(Row(Current), 'systemId'), 'Rename preserves identity.');
        Assert.AreNotEqual(Value(Original, 'version'), Value(Row(Current), 'version'), 'Rename advances version.');
        Probe.Execute(Mutation(RunId, CreateGuid(), Row(Current), 9, false));
        Commit();
        Assert.AreEqual(FirstResult, Probe.Execute(Request), 'Rename replay returns exact original result after later write.');
        CheckState(RunId, 9, 2, 2);
        Probe.Cleanup(RunRequest(RunId));
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure RenameFailureRollsBackKeyVersionAndReceipt()
    var
        RunId: Guid;
        RequestId: Guid;
        Original: JsonObject;
        Current: JsonObject;
    begin
        Prepare(RunId, Original);
        RequestId := CreateGuid();
        asserterror Probe.Execute(RenameRequest(RunId, RequestId, Original, true));
        Assert.ExpectedError('BCD_EV_AFTER_MUTATION');
        Current := State(RunId);
        Assert.AreEqual('ORIGINAL', Value(Row(Current), 'name'), 'Failed rename restores original key.');
        Assert.AreEqual(Value(Original, 'version'), Value(Row(Current), 'version'), 'Failed rename restores version.');
        CheckState(RunId, 0, 0, 0);
        Probe.Execute(RenameRequest(RunId, RequestId, Original, false));
        Commit();
        CheckState(RunId, 0, 1, 1);
        Probe.Cleanup(RunRequest(RunId));
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure RenameBindsOperationAndStaleRequestDoesNotConsumeId()
    var
        RunId: Guid;
        RequestId: Guid;
        Original: JsonObject;
        Current: JsonObject;
    begin
        Prepare(RunId, Original);
        Probe.Execute(Mutation(RunId, CreateGuid(), Original, 4, false));
        Commit();
        RequestId := CreateGuid();
        asserterror Probe.Execute(RenameRequest(RunId, RequestId, Original, false));
        Assert.ExpectedError('BCD_E04_CONFLICT');
        CheckState(RunId, 4, 1, 1);
        Current := State(RunId);
        Probe.Execute(RenameRequest(RunId, RequestId, Row(Current), false));
        Commit();
        asserterror Probe.Execute(Mutation(RunId, RequestId, Row(Current), 4, false));
        Assert.ExpectedError('BCD_EV_REQUEST_ID_REUSED');
        CheckState(RunId, 4, 2, 2);
        Probe.Cleanup(RunRequest(RunId));
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure InsertReplaysExactHistoryAfterLaterModify()
    var
        RunId: Guid;
        TargetId: Guid;
        Input: Text;
        Result: Text;
        Current: JsonObject;
    begin
        PrepareInsert(RunId, TargetId);
        Input := InsertRequest(RunId, CreateGuid(), TargetId, 4, false);
        Result := Probe.Execute(Input);
        Commit();
        Current := State(RunId);
        Assert.AreEqual(Format(TargetId, 0, 4), Value(Row(Current), 'systemId'), 'Caller identity persisted.');
        Probe.Execute(Mutation(RunId, CreateGuid(), Row(Current), 9, false));
        Commit();
        Assert.AreEqual(Result, Probe.Execute(Input), 'Insert replay returns original result after later modify.');
        CheckState(RunId, 9, 2, 2);
        Probe.Cleanup(RunRequest(RunId));
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure InsertFailureRollsBackTargetAndReservation()
    var
        RunId: Guid;
        TargetId: Guid;
        RequestId: Guid;
        Current: JsonObject;
    begin
        PrepareInsert(RunId, TargetId);
        RequestId := CreateGuid();
        asserterror Probe.Execute(InsertRequest(RunId, RequestId, TargetId, 4, true));
        Assert.ExpectedError('BCD_EV_AFTER_MUTATION');
        Current := State(RunId);
        Assert.AreEqual('false', LowerCase(Value(Row(Current), 'exists')), 'Failed insertion leaves no row.');
        Assert.AreEqual('0', Value(Current, 'receiptCount'), 'Failed insertion leaves no receipt.');
        Assert.AreEqual('0', Value(Current, 'applyCount'), 'Failed insertion leaves no apply.');
        Probe.Execute(InsertRequest(RunId, RequestId, TargetId, 4, false));
        Commit();
        CheckState(RunId, 4, 1, 1);
        Probe.Cleanup(RunRequest(RunId));
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure InsertConflictAndPayloadMismatchDoNotApplyAgain()
    var
        RunId: Guid;
        TargetId: Guid;
        RequestId: Guid;
    begin
        PrepareInsert(RunId, TargetId);
        RequestId := CreateGuid();
        Probe.Execute(InsertRequest(RunId, RequestId, TargetId, 4, false));
        Commit();
        asserterror Probe.Execute(InsertRequest(RunId, RequestId, TargetId, 9, false));
        Assert.ExpectedError('BCD_EV_REQUEST_ID_REUSED');
        asserterror Probe.Execute(InsertRequest(RunId, RequestId, CreateGuid(), 4, false));
        Assert.ExpectedError('BCD_EV_REQUEST_ID_REUSED');
        asserterror Probe.Execute(InsertRequest(RunId, CreateGuid(), TargetId, 4, false));
        Assert.ExpectedError('BCD_EV_INSERT_CONFLICT');
        asserterror Probe.Execute(InsertRequest(RunId, CreateGuid(), CreateGuid(), 4, false));
        Assert.ExpectedError('BCD_EV_INSERT_CONFLICT');
        CheckState(RunId, 4, 1, 1);
        Probe.Cleanup(RunRequest(RunId));
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure DeleteAcknowledgementReplaysWithoutTouchingReplacement()
    var
        RunId: Guid;
        Original: JsonObject;
        Current: JsonObject;
        Ack: JsonObject;
        Input: Text;
        Result: Text;
    begin
        Prepare(RunId, Original);
        Input := DeleteRequest(RunId, CreateGuid(), Original, false);
        Result := Probe.Execute(Input);
        Commit();
        Ack.ReadFrom(Result);
        Assert.IsFalse(Ack.Contains('row'), 'No deleted row values are stored/disclosed.');
        Assert.IsFalse(Ack.Contains('version'), 'Delete does not invent a new row version.');
        Assert.AreEqual(Value(Original, 'systemId'), Value(Ack, 'deletedSystemId'), 'Acknowledgement identifies deletion.');
        Assert.AreEqual('applied', Value(Ack, 'outcome'), 'Acknowledgement reports prior application.');
        Assert.AreEqual(Result, Probe.Execute(Input), 'Absent original target permits exact acknowledgement replay.');
        Probe.PrepareReplacement(RunRequest(RunId));
        Commit();
        Current := State(RunId);
        Assert.AreNotEqual(Value(Original, 'systemId'), Value(Row(Current), 'systemId'), 'Same-key replacement has a new identity.');
        Assert.AreEqual(Result, Probe.Execute(Input), 'Historical acknowledgement does not delete the replacement.');
        CheckState(RunId, 0, 1, 1);
        Probe.Cleanup(RunRequest(RunId));
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure DeleteFailureRestoresRowAndReservation()
    var
        RunId: Guid;
        RequestId: Guid;
        Original: JsonObject;
        Current: JsonObject;
    begin
        Prepare(RunId, Original);
        RequestId := CreateGuid();
        asserterror Probe.Execute(DeleteRequest(RunId, RequestId, Original, true));
        Assert.ExpectedError('BCD_EV_AFTER_MUTATION');
        Current := State(RunId);
        Assert.AreEqual(Value(Original, 'systemId'), Value(Row(Current), 'systemId'), 'Failed deletion restores identity.');
        Assert.AreEqual(Value(Original, 'version'), Value(Row(Current), 'version'), 'Failed deletion restores version.');
        CheckState(RunId, 0, 0, 0);
        Probe.Execute(DeleteRequest(RunId, RequestId, Original, false));
        Commit();
        Current := State(RunId);
        Assert.AreEqual('false', LowerCase(Value(Row(Current), 'exists')), 'Retry deletes the target.');
        Assert.AreEqual('1', Value(Current, 'receiptCount'), 'Only successful retry has a receipt.');
        Probe.Cleanup(RunRequest(RunId));
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure DeleteStaleIdRollsBackAndCompletedIdBindsVersion()
    var
        RunId: Guid;
        RequestId: Guid;
        Original: JsonObject;
        Current: JsonObject;
        Input: Text;
        Result: Text;
    begin
        Prepare(RunId, Original);
        Probe.Execute(Mutation(RunId, CreateGuid(), Original, 4, false));
        Commit();
        RequestId := CreateGuid();
        asserterror Probe.Execute(DeleteRequest(RunId, RequestId, Original, false));
        Assert.ExpectedError('BCD_E04_CONFLICT');
        CheckState(RunId, 4, 1, 1);
        Current := State(RunId);
        Input := DeleteRequest(RunId, RequestId, Row(Current), false);
        Result := Probe.Execute(Input);
        Commit();
        asserterror Probe.Execute(DeleteRequest(RunId, RequestId, Original, false));
        Assert.ExpectedError('BCD_EV_REQUEST_ID_REUSED');
        Assert.AreEqual(Result, Probe.Execute(Input), 'Completed ID replay precedes missing-target lookup.');
        Probe.Cleanup(RunRequest(RunId));
    end;

    local procedure DeleteRequest(RunId: Guid; RequestId: Guid; Target: JsonObject; Fail: Boolean): Text
    var
        Request: JsonObject;
        Output: Text;
    begin
        Request.ReadFrom(Mutation(RunId, RequestId, Target, 0, Fail));
        Request.Replace('operation', 'delete');
        Request.Remove('amount');
        Request.WriteTo(Output);
        exit(Output);
    end;

    local procedure PrepareInsert(var RunId: Guid; var TargetId: Guid)
    begin
        RunId := CreateGuid();
        TargetId := CreateGuid();
        Probe.PrepareEmpty(RunRequest(RunId));
        Commit();
    end;

    local procedure InsertRequest(RunId: Guid; RequestId: Guid; TargetId: Guid; Amount: Integer; Fail: Boolean): Text
    var
        Request: JsonObject;
        Output: Text;
    begin
        Request.Add('runId', Format(RunId, 0, 4));
        Request.Add('requestId', Format(RequestId, 0, 4));
        Request.Add('systemId', Format(TargetId, 0, 4));
        Request.Add('operation', 'insert');
        Request.Add('amount', Amount);
        Request.Add('failAfterMutation', Fail);
        Request.WriteTo(Output);
        exit(Output);
    end;

    local procedure RenameRequest(RunId: Guid; RequestId: Guid; Target: JsonObject; Fail: Boolean): Text
    var
        Request: JsonObject;
        Output: Text;
    begin
        Request.ReadFrom(Mutation(RunId, RequestId, Target, 0, Fail));
        Request.Replace('operation', 'rename');
        Request.Remove('amount');
        Request.WriteTo(Output);
        exit(Output);
    end;

    local procedure Prepare(var RunId: Guid; var Original: JsonObject)
    begin
        RunId := CreateGuid();
        Original.ReadFrom(Probe.Prepare(RunRequest(RunId)));
        Commit();
    end;

    local procedure Mutation(RunId: Guid; RequestId: Guid; Target: JsonObject; Amount: Integer; Fail: Boolean): Text
    var
        Request: JsonObject;
        Output: Text;
    begin
        Request.Add('runId', Format(RunId, 0, 4));
        Request.Add('requestId', Format(RequestId, 0, 4));
        Request.Add('systemId', Value(Target, 'systemId'));
        Request.Add('expectedVersion', Value(Target, 'version'));
        Request.Add('operation', 'modify');
        Request.Add('amount', Amount);
        Request.Add('failAfterMutation', Fail);
        Request.WriteTo(Output);
        exit(Output);
    end;

    local procedure State(RunId: Guid): JsonObject
    var
        Result: JsonObject;
    begin
        Result.ReadFrom(Probe.Inspect(RunRequest(RunId)));
        exit(Result);
    end;

    local procedure Row(StateValue: JsonObject): JsonObject
    var
        Token: JsonToken;
    begin
        StateValue.Get('row', Token);
        exit(Token.AsObject());
    end;

    local procedure Value(Object: JsonObject; Name: Text): Text
    var
        Token: JsonToken;
    begin
        Object.Get(Name, Token);
        exit(Token.AsValue().AsText());
    end;

    local procedure CheckState(RunId: Guid; Amount: Integer; Applies: Integer; Receipts: Integer)
    var
        Actual: JsonObject;
    begin
        Actual := State(RunId);
        Assert.AreEqual(Format(Amount, 0, 9), Value(Row(Actual), 'amount'), 'Persisted amount.');
        Assert.AreEqual(Format(Applies, 0, 9), Value(Actual, 'applyCount'), 'Committed apply count.');
        Assert.AreEqual(Format(Receipts, 0, 9), Value(Actual, 'receiptCount'), 'Committed receipts.');
        Assert.AreEqual('0', Value(Actual, 'pendingCount'), 'No pending receipt remains.');
    end;

    local procedure RunRequest(RunId: Guid): Text
    begin
        exit('{"runId":"' + Format(RunId, 0, 4) + '"}');
    end;

    var
        Probe: Codeunit "BCD Versioned Receipt Probe";
        Assert: Codeunit "Library Assert";
}
